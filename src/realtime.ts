// src/realtime.ts
import { WebSocket } from 'ws';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import os from 'os';

const prisma = new PrismaClient();
const openai = new OpenAI();

// The stages of our interview conversation
type SessionState = 'INTRO' | 'SMALL_TALK' | 'INTERVIEW' | 'CLOSING';

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
        
        // 1. Convert Audio Buffer to Text (Whisper)
        const userText = await this.transcribeAudio();
        console.log(`🗣️ User said: "${userText}"`);

        // 2. Clear buffer for next turn
        this.audioBuffer = [];

        // 3. Handle Logic based on State
        if (this.state === 'SMALL_TALK') {
            await this.handleSmallTalkResponse(userText);
        } 
        else if (this.state === 'INTERVIEW') {
            await this.handleInterviewResponse(userText);
        }
    }

    // --- 🧠 SMART BANTER LOGIC (Fast) ---
    private async handleSmallTalkResponse(userText: string) {
        // Use GPT-4o-mini for speed (approx 50% faster than GPT-4o)
        const prompt = `
        You are a friendly Hiring Manager.
        User said: "${userText}".
        Reply naturally, acknowledge what they said, then transition to the interview.
        Keep it warm but brief (under 2 sentences).
        End with something like "Let's dive in."
        `;

        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini", 
                messages: [{ role: "system", content: prompt }],
                max_tokens: 60
            });

            const aiResponse = response.choices[0].message.content || "That's great. Let's get started.";
            await this.speak(aiResponse);

        } catch (err) {
            console.error("Banter Error:", err);
            await this.speak("Great. Let's get started.");
        }

        // Move to the first question
        this.state = 'INTERVIEW';
        this.askCurrentQuestion();
    }

    // --- 🔴 PHASE 3: INTERVIEW LOOP ---
    private async handleInterviewResponse(userText: string) {
        // Simple bridge to acknowledge the answer
        // In the future, you could analyze 'userText' to see if they actually answered well.
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
            this.state = 'CLOSING';
            await this.speak("That actually covers everything I wanted to ask. Thank you so much for your time today!");
        }
    }

    private async askCurrentQuestion() {
        if (this.currentQuestionIndex < this.questions.length) {
            const question = this.questions[this.currentQuestionIndex];
            await this.speak(question);
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