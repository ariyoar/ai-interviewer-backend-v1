// src/index.ts
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient, AssessmentType } from '@prisma/client';
import multer from 'multer';
import pdf from 'pdf-parse';
import { OpenAIRealtimeSession } from './openai-realtime';
import assessmentRoutes from './routes/assessments';
import { IInterviewSession } from './types';

dotenv.config();

// 1. INITIALIZE APP FIRST
const app = express();
const prisma = new PrismaClient();
const server = createServer(app);
const wss = new WebSocketServer({ server });

// 2. CONFIGURE MIDDLEWARE
app.use(cors());
app.use(express.json({ limit: '50mb' })); // Increased limit for Base64 resumes
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 3. REGISTER ROUTES
app.use('/api/assessments', assessmentRoutes);

// Health Check
app.get('/health', (req, res) => {
    res.send('AI Interviewer Backend is running (Realtime API)');
});

// Configure Multer for memory storage
const upload = multer({ storage: multer.memoryStorage() });

// --- API: CREATE SESSION ---
app.post('/api/session', upload.single('resume'), async (req: any, res: any) => {
    try {
        const { role, experience, jobDescription, description, duration, companyName, industry, region, type, rubric } = req.body;

        // Handle both keys for backward compatibility
        const finalJobDescription = jobDescription || description || "";

        console.log(`[API] Creating Session: ${role} (${experience})`);

        let resumeText = "";
        let resumeBase64 = "";

        // Handle PDF Resume
        if (req.file) {
            try {
                const pdfData = await pdf(req.file.buffer);
                // Sanitize: Postgres does not allow null bytes (0x00) in text fields
                resumeText = pdfData.text.replace(/\x00/g, '').slice(0, 3000);
                resumeBase64 = req.file.buffer.toString('base64');
                console.log("✅ Resume extracted & encoded.");
            } catch (err) {
                console.error("❌ PDF Error:", err);
            }
        }

        const session = await prisma.interviewSession.create({
            data: {
                role: role || "Software Engineer",
                experience: experience || "Junior",
                jobDescription: finalJobDescription,
                durationMinutes: parseInt(duration) || 15,
                companyName: companyName || "",
                industry: industry || "", // Allow empty industry
                region: region || "USA",
                resumeText: resumeText,
                resumeFile: resumeBase64,
                // New Fields
                type: (type as AssessmentType) || AssessmentType.PRACTICE,
                rubric: rubric || "",
                language: req.body.language || "English" // 🌐 Save Language
            }
        });

        res.json(session);

    } catch (error: any) {
        console.error("Session Create Error:", error);
        res.status(500).json({
            error: "Failed to create session",
            details: error.message,
            stack: process.env.NODE_ENV === 'production' ? undefined : error.stack
        });
    }
});

// --- WEBSOCKET HANDLING ---
const activeSessions: Map<string, OpenAIRealtimeSession> = new Map();
const MAX_CONCURRENT_SESSIONS = 10;

wss.on('connection', async (ws: WebSocket, req) => {
    const urlParams = new URLSearchParams(req.url?.split('?')[1]);
    const sessionId = urlParams.get('sessionId');

    // 1. LIMIT CHECK
    if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
        console.warn(`⚠️ Server Full (${activeSessions.size} active). Rejecting connection.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Server is at max capacity. Please try again later.' }));
        ws.close(1013, "Server Full");
        return;
    }

    // --- HYBRID HANDSHAKE HANDLER ---
    // Supports both ?sessionId=XYZ (new) and {"type": "init_session"} (legacy)

    let currentSessionId: string | null = sessionId;
    let realtimeSession: OpenAIRealtimeSession | null = null;

    const initializeSession = async (sid: string) => {
        if (!sid) return;
        currentSessionId = sid;
        console.log(`🔌 Client connected: ${sid}`);

        try {
            // Fetch Session
            const session = await prisma.interviewSession.findUnique({ where: { id: sid } });
            if (!session) {
                console.error(`❌ Session ${sid} not found in DB`);
                ws.send(JSON.stringify({ type: 'error', message: 'Session not found' }));
                ws.close(1008, "Session not found");
                return;
            }

            // Init Realtime Session
            realtimeSession = new OpenAIRealtimeSession(ws, sid, () => {
                console.log(`[Session] Self-terminating session ${sid}`);
                activeSessions.delete(sid);
            });
            realtimeSession.setContext({
                role: session.role,
                experience: session.experience,
                jobDescription: session.jobDescription || "",
                resumeText: session.resumeText || "",
                durationMinutes: session.durationMinutes,
                industry: session.industry || "", // Allow empty
                region: session.region || "USA",
                companyName: session.companyName || "", // ✅ Pass Company Name
                language: session.language || "English" // 🌐 Pass Language
            });

            activeSessions.set(sid, realtimeSession);
            await realtimeSession.connect();

        } catch (err) {
            console.error("❌ WS Init Error:", err);
            ws.close(1011, "Internal Error");
        }
    };

    // If sessionId provided in URL, init immediately
    if (currentSessionId) {
        initializeSession(currentSessionId);
    }

    // Listen for messages (Handle "init_session" fallback + normal Events)
    ws.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message.toString());

            // 1. Legacy Handshake: init_session
            if (!currentSessionId && data.type === 'init_session') {
                console.log(`handshake: received init_session for ${data.sessionId}`);
                await initializeSession(data.sessionId);
                return;
            }

            // 2. Normal Events (only if session initialized)
            if (activeSessions.has(currentSessionId!) && realtimeSession) {
                if (data.type === 'audio_chunk' || data.type === 'input_audio_buffer.append') {
                    realtimeSession.handleUserAudio(data.audio);
                }
                else if (data.type === 'user_speaking_end' || data.type === 'input_audio_buffer.commit') {
                    await realtimeSession.commitUserAudio();
                }
                else if (data.type === 'ai_playback_complete') {
                    realtimeSession.handleAiPlaybackComplete();
                }
            }

        } catch (err) {
            console.error("WebSocket Message Error:", err);
        }
    });

    // Cleanup on disconnect
    ws.on('close', () => {
        if (currentSessionId && activeSessions.has(currentSessionId)) {
            console.log(`🔌 Client disconnected: ${currentSessionId}`);
            activeSessions.get(currentSessionId)?.close();
            activeSessions.delete(currentSessionId);
        }
    });
});

// START SERVER
const PORT = process.env.PORT || 8080;
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});