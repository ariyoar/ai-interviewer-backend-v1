// src/index.ts
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import pdf from 'pdf-parse';
import { generatePrimaryQuestions } from './openai';
import { RealtimeSession } from './realtime';

// Load environment variables
dotenv.config();

// 1. INITIALIZE APP FIRST
const app = express();
const prisma = new PrismaClient();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 2. CONFIGURE MIDDLEWARE
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Use a higher limit (50mb) to handle large PDF Base64 strings
app.use(express.json({ limit: '50mb' }));

// Store active voice sessions in memory
const activeSessions = new Map<string, RealtimeSession>();

// 🚀 CONCURRENCY CONTROL: Define the maximum number of active interview sessions
const MAX_CONCURRENT_SESSIONS = 5;

// --- REST API: Session Creation ---
app.post('/api/session', async (req, res) => {
    try {
        const {
            role,
            experience,
            durationMinutes,
            companyName,
            jobDescription,
            industry,
            region,
            resumeText,
            resumeFile
        } = req.body;

        console.log("📝 Received Session Request...");

        // --- 🔍 ROBUST PDF PARSING LOGIC ---
        let finalResumeText = "";

        if (resumeFile) {
            console.log("📂 PDF File detected. Extracting text...");
            try {
                // 1. Sanitize Base64 (remove data URI scheme if present)
                const base64Clean = resumeFile.replace(/^data:.*,/, '');
                console.log(`PO: Base64 Header (Raw): ${resumeFile.slice(0, 30)}...`);
                console.log(`PO: Base64 Cleaned? ${resumeFile !== base64Clean}`);

                const buffer = Buffer.from(base64Clean, 'base64');
                console.log(`PO: Buffer created. Size: ${buffer.length} bytes.`);

                const pdfData = await pdf(buffer);
                console.log(`PO: PDF Parse complete. NumPages: ${pdfData.numpages}, Info:`, pdfData.info);

                finalResumeText = pdfData.text.replace(/\n\s*\n/g, '\n').trim();
                console.log(`✅ PDF Extracted! Length: ${finalResumeText.length} chars`);
                if (finalResumeText.length < 100) {
                    console.warn("⚠️ WARNING: Extracted text is suspiciously short:", finalResumeText);
                } else {
                    console.log("📄 Snippet:", finalResumeText.slice(0, 100));
                }
            } catch (err) {
                console.error("❌ PDF Parse failed:", err);
            }
        }

        if (!finalResumeText && resumeText) {
            const cleanChars = resumeText.replace(/[^a-zA-Z0-9\s]/g, '').length;
            const validRatio = cleanChars / resumeText.length;

            if (validRatio > 0.4) {
                finalResumeText = resumeText;
                console.log("Using provided resumeText (seems valid).");
            } else {
                console.warn("⚠️ Ignoring corrupt/garbage frontend resume text.");
            }
        }

        if (!finalResumeText) {
            console.log("⚠️ No valid resume text found. Using placeholder.");
            finalResumeText = "Candidate summary not available.";
        }

        // 2. Create the session in DB
        const session = await prisma.interviewSession.create({
            data: {
                role,
                experience,
                durationMinutes,
                companyName,
                region,
                industry,
                jobDescription,
                resumeText: finalResumeText,
                resumeFile: resumeFile ? "saved_as_base64" : null
            }
        });

        console.log(`Session created: ${session.id}`);

        // 3. Generate Questions using OpenAI
        const questions = await generatePrimaryQuestions({
            role,
            experience,
            duration: durationMinutes,
            jobDescription,
            companyName,
            industry,
            region,
            resumeText: finalResumeText
        });

        // 4. Save Questions to DB
        if (questions.length > 0) {
            await prisma.interviewQuestion.createMany({
                data: questions.map((q, index) => ({
                    sessionId: session.id,
                    question: q,
                    order: index + 1
                }))
            });
            console.log(`✅ Saved ${questions.length} questions.`);
        }

        // 5. Return everything to frontend
        res.json({ ...session, questions });

    } catch (error) {
        console.error("Error creating session:", error);
        res.status(500).json({ error: "Failed to create session" });
    }
});

// --- WEBSOCKET: Real-time Audio/Text ---
wss.on('connection', (ws: WebSocket) => {
    console.log('New client connected');

    // Track the session ID for this specific socket connection
    let currentSessionId: string | null = null;

    ws.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message.toString());



            // 1. Init Session: Connect Frontend <-> Backend <-> OpenAI
            if (data.type === 'init_session') {

                // 🛑 CAPACITY CHECK
                if (activeSessions.size >= MAX_CONCURRENT_SESSIONS) {
                    console.warn(`🛑 Rejected session. Server at capacity (${activeSessions.size}/${MAX_CONCURRENT_SESSIONS})`);
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Server is at maximum capacity. Please try again in a moment.'
                    }));
                    ws.close();
                    return;
                }

                currentSessionId = data.sessionId;
                console.log(`Socket linked to session: ${currentSessionId}. Active Sessions: ${activeSessions.size + 1}/${MAX_CONCURRENT_SESSIONS}`);

                if (currentSessionId) {
                    const realtime = new RealtimeSession(ws, currentSessionId);
                    activeSessions.set(currentSessionId, realtime);
                }
            }

            // Get the active session object
            const session = currentSessionId ? activeSessions.get(currentSessionId) : null;

            if (session) {
                // 2. Handle Audio Stream
                if (data.type === 'audio_chunk' || data.type === 'input_audio_buffer.append') {
                    session.handleUserAudio(data.audio);
                }

                // 3. User Stopped Speaking
                else if (data.type === 'user_speaking_end' || data.type === 'input_audio_buffer.commit') {
                    console.log('User finished speaking. Committing audio...');
                    await session.commitUserAudio();
                }

                // 4. 🚨 NEW: Handle Playback Complete Signal (Triggers Silence Timer)
                else if (data.type === 'ai_playback_complete') {
                    console.log("📨 Received playback complete signal from frontend");
                    session.handleAiPlaybackComplete();
                }
            }

        } catch (err) {
            console.error("WebSocket error:", err);
        }
    });

    // Cleanup on disconnect
    ws.on('close', () => {
        if (currentSessionId) {
            activeSessions.delete(currentSessionId);
            console.log(`Session ${currentSessionId} disconnected`);
        }
    });
});

// Start Server
const PORT = process.env.PORT || 8080;
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});