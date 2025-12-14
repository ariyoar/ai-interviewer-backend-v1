// src/realtime.ts
import { WebSocket } from 'ws';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import os from 'os';

const prisma = new PrismaClient();
const openai = new OpenAI();

// Added 'Q_AND_A' to the flow
type SessionState = 'INTRO' | 'SMALL_TALK' | 'INTERVIEW' | 'Q_AND_A' | 'CLOSING';

export class RealtimeSession {
    private ws: WebSocket;
    private sessionId: string;
    private state: SessionState = 'INTRO'; // Starts here!
    private currentQuestionIndex: number = 0;
    private questions: string[] = [];
    
    // Audio Buffering (To "Hear" the user)
    private audioBuffer: Buffer[] = [];
    
    // Context
    private role: string = "";
    private company: string = "";
    private jobDescription: string = ""; // Added to answer user questions contextually

    constructor(ws: WebSocket, sessionId: string) {
        this.ws = ws;
        this.sessionId = sessionId;
        this.init();
    }

    private async init() {
        const session = await prisma.interviewSession.findUnique({
            where: { id: this.sessionId },
            include: { questions: { orderBy: { order: 'asc' } } }
        });

        if (!session) return;

        this.role = session.role;
        this.company = session.companyName || "our company";
        this.jobDescription = session.jobDescription || "";
        this.questions = session.questions.map(q => q.question);

        // Start the conversation immediately
        this.handleIntro();
    }

    // --- 🟢 PHASE 1: INTRO ---
    private async handleIntro() {
        console.log("👋 Sending Intro Greeting...");
        const greeting = `Hi there! Thanks for joining. I'm the Hiring Manager for the ${this.role} role at ${this.company}. How are you doing today?`;
        
        await this.speak(greeting);
        this.state = 'SMALL_TALK'; 
    }

    // --- 🎤 HANDLE USER SPEECH ---
    public handleUserAudio(base64Audio: string) {
        // Collect chunks so we can transcribe them later
        const buffer = Buffer.from(base64Audio, 'base64');
        this.audioBuffer.push(buffer);
    }

    public async commitUserAudio() {
        console.log(`User finished speaking. Processing audio for state: ${this.state}`);
        
        // 1. Guard: If buffer is empty, do nothing
        if (this.audioBuffer.length === 0) {
             console.log("⚠️ Audio buffer empty. Ignoring.");
             return;
        }

        // 2. Convert Audio Buffer to Text (Whisper)
        const rawText = await this.transcribeAudio();
        console.log(`🗣️ Raw Transcript: "${rawText}"`);

        // --- 🛡️ SILENCE GUARD ---
        // Clean the text to check if it's real input
        const cleanText = rawText.trim().toLowerCase().replace(/[.,!?]/g, '');
        
        // Common hallucinations Whisper produces on silence
        const hallucinations = [
            'thank you', 'thanks', 'you', 'bye', 
            'subtitle by', 'amara', 'mbc', 
            '' 
        ];

        // If the text is too short (< 2 chars) or is a known hallucination, IGNORE it.
        if (cleanText.length < 2 || hallucinations.includes(cleanText)) {
            console.log("⚠️ Ignoring empty/hallucinated input (Silence Guard).");
            this.audioBuffer = []; // Clear the buffer
            return; 
        }
        // -----------------------------------

        // 3. Clear buffer for next turn
        this.audioBuffer = [];

        // 4. Handle Valid Logic based on State
        if (this.state === 'SMALL_TALK') {
            await this.handleSmallTalkResponse(rawText);
        } 
        else if (this.state === 'INTERVIEW') {
            await this.handleInterviewResponse(rawText);
        }
        else if (this.state === 'Q_AND_A') {
            await this.handleQandAResponse(rawText);
        }
    }

    // --- 🧠 SMART BANTER LOGIC (Fast) ---
    private async handleSmallTalkResponse(userText: string) {
        const prompt = `
        You are a friendly Hiring Manager.
        User said: "${userText}".
        Reply naturally, acknowledge what they said, then transition to the interview.
        Keep it warm but brief (under 2 sentences).
        End with something like "Let's dive in."
        `;

        const response = await this.askGPT(prompt, 60);
        await this.speak(response);

        // Move to the first question
        this.state = 'INTERVIEW';
        this.askCurrentQuestion();
    }

    // --- 🔴 PHASE 3: INTERVIEW LOOP ---
    private async handleInterviewResponse(userText: string) {
        // Simple bridge to acknowledge the answer
        const acknowledgments = [
            "Thanks for sharing that.",
            "That makes sense.",
            "I appreciate that context.",
            "Got it.",
            "That's a solid example."
        ];
        const bridge = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];

        this.currentQuestionIndex++;
        
        if (this.currentQuestionIndex < this.questions.length) {
            const nextQ = this.questions[this.currentQuestionIndex];
            await this.speak(`${bridge} ${nextQ}`);
        } else {
            // All questions done -> Move to Q&A instead of Closing
            this.state = 'Q_AND_A';
            await this.speak("That actually covers everything I wanted to ask. Before we finish, do you have any questions for me about the role or the company?");
        }
    }

    // --- 🔵 PHASE 4: Q&A + AUTOMATIC END ---
    private async handleQandAResponse(userText: string) {
        // 1. Check if the user is saying "No questions" or "I'm done"
        const isDone = await this.checkIfDone(userText);

        if (isDone) {
            this.state = 'CLOSING';
            await this.speak("Great! It was a pleasure meeting you. We will be in touch shortly. Have a great day!");
            
            // 🚨 TRIGGER FRONTEND TO END INTERVIEW AUTOMATICALLY
            console.log("🏁 Interview Complete. Sending termination signal.");
            setTimeout(() => {
                this.ws.send(JSON.stringify({ type: 'interview.complete' }));
            }, 4000); // Wait 4s for audio to finish playing
        } else {
            // 2. User asked a question -> Answer it using context
            const prompt = `
            You are the Hiring Manager for the ${this.role} role at ${this.company}.
            Job Description Context: ${this.jobDescription}
            
            User asked: "${userText}"
            
            Answer their question briefly and professionally based on the context. 
            If the answer isn't in the context, say you'll check with the team.
            End by asking "Do you have any other questions?"
            `;
            
            const answer = await this.askGPT(prompt, 150);
            await this.speak(answer);
        }
    }

    private async askCurrentQuestion() {
        if (this.currentQuestionIndex < this.questions.length) {
            const question = this.questions[this.currentQuestionIndex];
            await this.speak(question);
        }
    }

    // --- HELPER: GPT (Generic) ---
    private async askGPT(systemPrompt: string, maxTokens: number = 100): Promise<string> {
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini", 
                messages: [{ role: "system", content: systemPrompt }],
                max_tokens: maxTokens
            });
            return response.choices[0].message.content || "Let's move on.";
        } catch (err) {
            console.error("GPT Error:", err);
            return "Let's continue.";
        }
    }

    // --- HELPER: CHECK IF DONE ---
    private async checkIfDone(text: string): Promise<boolean> {
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [
                    { role: "system", content: "Analyze if the user text means 'I have no questions', 'No', 'I'm good', or 'I am done'. Return TRUE if they are done, FALSE if they asked a question." },
                    { role: "user", content: text }
                ],
                max_tokens: 5
            });
            const content = response.choices[0].message.content?.toLowerCase() || "false";
            return content.includes("true");
        } catch (e) {
            return false; // Assume not done if error
        }
    }

    // --- 👂 HELPER: TRANSCRIBE (Whisper) ---
    private async transcribeAudio(): Promise<string> {
        if (this.audioBuffer.length === 0) return "";

        // Write buffer to a temp file
        const tempFilePath = path.join(os.tmpdir(), `upload_${this.sessionId}_${Date.now()}.wav`);
        const fullBuffer = Buffer.concat(this.audioBuffer);
        fs.writeFileSync(tempFilePath, fullBuffer);

        try {
            const transcription = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempFilePath),
                model: "whisper-1",
            });
            return transcription.text;
        } catch (err) {
            console.error("Transcription failed:", err);
            return "";
        } finally {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        }
    }

    // --- 🔊 HELPER: SPEAK ---
    private async speak(text: string) {
        // FORCE UPDATE: Add this log to verify the text is queuing
        console.log(`📤 Sending text to frontend: "${text}"`);

        // Send Text (Frontend displays this in live captions)
        this.ws.send(JSON.stringify({ type: 'ai_text', text }));

        try {
            const mp3 = await openai.audio.speech.create({
                model: "tts-1",
                voice: "alloy",
                input: text,
            });
            const buffer = Buffer.from(await mp3.arrayBuffer());
            
            this.ws.send(JSON.stringify({
                type: 'ai_audio_chunk',
                audio: buffer.toString('base64')
            }));
        } catch (err) {
            console.error("TTS Error:", err);
        }
    }
}