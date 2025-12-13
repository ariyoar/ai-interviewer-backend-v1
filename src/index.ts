// src/index.ts
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { generatePrimaryQuestions } from './openai'; // The "Brain" for questions
import { RealtimeSession } from './realtime';        // The "Voice" loop

// Load environment variables
dotenv.config();

// 1. INITIALIZE APP FIRST (Crucial Step)
const app = express();
const prisma = new PrismaClient();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 2. CONFIGURE MIDDLEWARE
// Fix: We moved this AFTER 'const app = express()' so it actually works
app.use(cors({
    origin: '*', // Allow connections from ANY website (Lovable, localhost, etc.)
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Use a single JSON parser with the higher limit for Resumes
app.use(express.json({ limit: '10mb' }));

// Store active voice sessions in memory
// Map<SessionID, RealtimeSessionInstance>
const activeSessions = new Map<string, RealtimeSession>();

// --- REST API: Session Creation (Requirement 1.1) ---
app.post('/api/session', async (req, res) => {
    try {
        // 1. Destructure ALL the new fields from your Lovable form
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
        
        // 2. Create the session in DB with ALL new fields
        const session = await prisma.interviewSession.create({
            data: {
                role,
                experience,
                durationMinutes,
                companyName,
                region,           
                industry,         
                jobDescription,
                resumeText,
                resumeFile
            }
        });

        console.log(`Session created: ${session.id}`);

        // 3. Generate Questions using OpenAI (The "Brain")
        const questions = await generatePrimaryQuestions({
            role,
            experience,
            duration: durationMinutes,
            jobDescription,
            companyName,
            industry,
            region,
            resumeText          // ✅ Passed Resume to AI
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

// --- WEBSOCKET: Real-time Audio/Text (Requirement 3) ---
wss.on('connection', (ws: WebSocket) => {
    console.log('New client connected');

    // Track the session ID for this specific socket connection
    let currentSessionId: string | null = null;

    ws.on('message', async (message: string) => {
        try {
            const data = JSON.parse(message.toString());

            // 1. Init Session: Connect Frontend <-> Backend <-> OpenAI
            if (data.type === 'init_session') {
                currentSessionId = data.sessionId;
                console.log(`Socket linked to session: ${currentSessionId}`);
                
                if (currentSessionId) {
                    // Create the dedicated OpenAI connection for this user
                    const realtime = new RealtimeSession(ws, currentSessionId);
                    activeSessions.set(currentSessionId, realtime);
                }
            }

            // 2. Handle Audio Stream (Chunk by chunk from Frontend)
            if (data.type === 'audio_chunk' && currentSessionId) {
                const session = activeSessions.get(currentSessionId);
                if (session) {
                    session.handleUserAudio(data.audio);
                }
            }

            // 3. User Stopped Speaking (Spacebar Release)
            if (data.type === 'user_speaking_end' && currentSessionId) {
                console.log('User finished speaking. Committing audio...');
                const session = activeSessions.get(currentSessionId);
                if (session) {
                    // Tell OpenAI to stop listening and start thinking
                    session.commitUserAudio();
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
server.listen(PORT, () => {
    console.log(`✅ Server running on http://localhost:${PORT}`);
});