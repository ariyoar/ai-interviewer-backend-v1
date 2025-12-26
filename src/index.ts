// src/index.ts
import express from 'express';
import { createServer } from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
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
app.use(express.json());

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
        const { role, experience, description, duration, companyName, industry, region, type, rubric } = req.body;

        console.log(`[API] Creating Session: ${role} (${experience})`);

        let resumeText = "";
        let resumeBase64 = "";

        // Handle PDF Resume
        if (req.file) {
            try {
                const pdfData = await pdf(req.file.buffer);
                resumeText = pdfData.text.slice(0, 3000); // Limit context
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
                jobDescription: description || "",
                durationMinutes: parseInt(duration) || 15,
                companyName: companyName || "",
                industry: industry || "Tech",
                region: region || "USA",
                resumeText: resumeText,
                resumeFile: resumeBase64,
                // New Fields
                type: type || 'PRACTICE',
                rubric: rubric || ""
            }
        });

        res.json(session);

    } catch (error) {
        console.error("Session Create Error:", error);
        res.status(500).json({ error: "Failed to create session" });
    }
});

// --- WEBSOCKET HANDLING ---
const activeSessions: Map<string, OpenAIRealtimeSession> = new Map();
const MAX_CONCURRENT_SESSIONS = 10;

wss.on('connection', async (ws: WebSocket, req) => {
    const urlParams = new URLSearchParams(req.url?.split('?')[1]);
    const sessionId = urlParams.get('sessionId');

    if (!sessionId) {
        console.log("❌ Connection rejected: No sessionId");
        ws.close(1008, "Missing sessionId");
        return;
    }

    // 1. LIMIT CHECK
    if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
        console.warn(`⚠️ Server Full (${activeSessions.size} active). Rejecting ${sessionId}.`);
        ws.send(JSON.stringify({ type: 'error', message: 'Server is at max capacity. Please try again later.' }));
        ws.close(1013, "Server Full");
        return;
    }

    console.log(`🔌 Client connected: ${sessionId}`);

    try {
        // 2. FETCH SESSION DATA
        const session = await prisma.interviewSession.findUnique({ where: { id: sessionId } });
        if (!session) {
            ws.close(1008, "Session not found");
            return;
        }

        // 3. INITIALIZE REALTIME SESSION
        const realtimeSession = new OpenAIRealtimeSession(ws, sessionId);

        // Inject Context
        realtimeSession.setContext({
            role: session.role,
            experience: session.experience,
            jobDescription: session.jobDescription || "",
            resumeText: session.resumeText || "",
            durationMinutes: session.durationMinutes,
            industry: session.industry || "Tech",
            region: session.region || "USA"
        });

        // Store
        activeSessions.set(sessionId, realtimeSession);

        // Connect to OpenAI
        await realtimeSession.connect();

        // Cleanup on disconnect
        ws.on('close', () => {
            console.log(`🔌 Client disconnected: ${sessionId}`);
            realtimeSession.close();
            activeSessions.delete(sessionId);
        });

    } catch (err) {
        console.error("❌ WS Init Error:", err);
        ws.close(1011, "Internal Error");
    }
});

// START SERVER
const PORT = process.env.PORT || 8080;
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});