// src/realtime.ts
import { WebSocket } from 'ws';
import OpenAI from 'openai';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const openai = new OpenAI();

// The stages of our interview conversation
type SessionState = 'INTRO' | 'SMALL_TALK' | 'INTERVIEW' | 'CLOSING';

export class RealtimeSession {
    private ws: WebSocket;
    private sessionId: string;
    private state: SessionState = 'INTRO'; // <--- STARTS HERE
    private currentQuestionIndex: number = 0;
    private questions: string[] = [];
    
    // Context for the persona
    private role: string = "";
    private company: string = "";

    constructor(ws: WebSocket, sessionId: string) {
        this.ws = ws;
        this.sessionId = sessionId;
        this.init();
    }

    private async init() {
        // 1. Load Session Data
        const session = await prisma.interviewSession.findUnique({
            where: { id: this.sessionId },
            include: { questions: { orderBy: { order: 'asc' } } }
        });

        if (!session) return;

        this.role = session.role;
        this.company = session.companyName || "our company";
        this.questions = session.questions.map(q => q.question);

        // 2. Start the Conversation (INTRO)
        // This triggers the "Hi there" IMMEDIATELY when the socket connects
        this.handleIntro();
    }

    // --- 🟢 PHASE 1: INTRO ---
    private async handleIntro() {
        console.log("👋 Sending Intro Greeting...");
        const greeting = `Hi there! Thanks for joining. I'm the Hiring Manager for the ${this.role} role at ${this.company}. How are you doing today?`;
        
        // Send Audio & Text
        await this.speak(greeting);
        
        // Update State: We are now waiting for the user to say "I'm good"
        this.state = 'SMALL_TALK'; 
    }

    // --- 🎤 HANDLE USER SPEECH ---
    public async handleUserAudio(audioBase64: string) {
        // (Buffer logic would go here in production)
    }

    // Triggered when user finishes speaking
    public async commitUserAudio() {
        console.log(`User finished speaking. Current State: ${this.state}`);

        if (this.state === 'SMALL_TALK') {
            // User just said "I'm good, thanks." -> We transition to interview.
            await this.transitionToInterview();
        } 
        else if (this.state === 'INTERVIEW') {
            // User just answered a technical question. -> We acknowledge and move on.
            await this.handleInterviewResponse();
        }
    }

    // --- 🟡 PHASE 2: TRANSITION ---
    private async transitionToInterview() {
        console.log("🚀 Transitioning to Interview Mode");
        const transition = "That's great to hear. We have a lot to cover, so let's dive right in. I'd love to start by learning a bit more about your background.";
        await this.speak(transition);
        
        this.state = 'INTERVIEW';
        // Now we explicitly ask Question 1
        this.askCurrentQuestion();
    }

    // --- 🔴 PHASE 3: INTERVIEW LOOP ---
    private async handleInterviewResponse() {
        // 1. Acknowledge the previous answer (The "Bridge")
        const acknowledgments = [
            "Thanks for sharing that detail.",
            "That makes sense.",
            "I appreciate that example.",
            "Got it, that's a clear explanation.",
            "That's a solid approach."
        ];
        const bridge = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];

        // 2. Move to next question
        this.currentQuestionIndex++;
        
        if (this.currentQuestionIndex < this.questions.length) {
            const nextQ = this.questions[this.currentQuestionIndex];
            await this.speak(`${bridge} ${nextQ}`);
        } else {
            this.state = 'CLOSING';
            await this.speak("That actually covers everything I wanted to ask. Do you have any questions for me before we wrap up?");
        }
    }

    private async askCurrentQuestion() {
        if (this.currentQuestionIndex < this.questions.length) {
            const question = this.questions[this.currentQuestionIndex];
            await this.speak(question);
        }
    }

    // --- 🔊 HELPER: SPEAK ---
    private async speak(text: string) {
        // Send Text (Frontend might display this in a caption bubble)
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