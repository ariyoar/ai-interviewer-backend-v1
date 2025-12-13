// src/index.ts
import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
const pdf = require('pdf-parse');
import { generatePrimaryQuestions } from './openai'; // The "Brain" for questions
import { RealtimeSession } from './realtime';        // The "Voice" loop

// Load environment variables
dotenv.config();

// 1. INITIALIZE APP FIRST
const app = express();
const prisma = new PrismaClient();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// 2. CONFIGURE MIDDLEWARE
app.use(cors({
    origin: '*', // Allow connections from ANY website
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type']
}));

// Use a higher limit (50mb) to handle large PDF Base64 strings
app.use(express.json({ limit: '50mb' }));

// Store active voice sessions in memory
const activeSessions = new Map<string, RealtimeSession>();

// --- REST API: Session Creation ---
app.post('/api/session', async (req, res) => {
    try {
        // 1. Destructure ALL fields
        const { 
            role, 
            experience, 
            durationMinutes, 
            companyName, 
            jobDescription, 
            industry, 
            region,
            resumeText,
            resumeFile // This comes in as a Base64 string
        } = req.body;
        
        console.log("📝 Received Session Request...");

        // --- 🔍 PDF PARSING LOGIC START ---
        // Default to the plain text provided, or empty string
        let finalResumeText = resumeText || "";

        if (resumeFile) {
            console.log("📂 PDF File detected. Extracting text...");
            try {
                // 1. Convert Base64 string to a Buffer
                const buffer = Buffer.from(resumeFile, 'base64');
                
                // 2. Extract text using pdf-parse
                const pdfData = await pdf(buffer);
                
                // 3. Clean up the text (remove excessive newlines/spaces)
                // This replaces multiple newlines with a single newline to make it readable for AI
                finalResumeText = pdfData.text.replace(/\n\s*\n/g, '\n').trim(); 
                
                console.log(`✅ PDF Extracted! Length: ${finalResumeText.length} chars`);
            } catch (err) {
                console.error("❌ Failed to parse PDF:", err);
                // If parsing fails, we fall back to whatever was in 'resumeText' or empty string
            }
        }
        // --- 🔍 PDF PARSING LOGIC END ---

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
                resumeText: finalResumeText, // ✅ Save the CLEAN extracted text
                resumeFile: resumeFile ? "saved_as_base64" : null // Optional: Indicate file was sent
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
            resumeText: finalResumeText // ✅ Pass CLEAN text to AI
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

// Start Server (Updated for Railway Production)
const PORT = process.env.PORT || 8080;
server.listen(Number(PORT), '0.0.0.0', () => {
    console.log(`✅ Server running on port ${PORT}`);
});
//