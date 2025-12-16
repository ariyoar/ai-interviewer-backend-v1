// src/realtime.ts
import { WebSocket } from 'ws';
import OpenAI from 'openai';
import { ElevenLabsClient } from 'elevenlabs'; 
import { PrismaClient } from '@prisma/client';
import fs from 'fs';
import path from 'path';
import os from 'os';

const prisma = new PrismaClient();
const openai = new OpenAI();

// 🚨 SAFE INITIALIZATION: Don't crash if key is missing
let elevenlabs: ElevenLabsClient | null = null;
if (process.env.ELEVENLABS_API_KEY) {
    try {
        elevenlabs = new ElevenLabsClient({ apiKey: process.env.ELEVENLABS_API_KEY });
        console.log("✅ ElevenLabs Client Initialized");
    } catch (err) { console.error("⚠️ Failed to init ElevenLabs:", err); }
} else {
    console.warn("⚠️ ELEVENLABS_API_KEY is missing! Audio will fail or fallback.");
}

type SessionState = 'INTRO' | 'SMALL_TALK' | 'INTERVIEW' | 'Q_AND_A' | 'CLOSING';

export class RealtimeSession {
    private ws: WebSocket;
    private sessionId: string;
    private state: SessionState = 'INTRO'; 
    private currentQuestionIndex: number = 0;
    private questions: string[] = [];
    private audioBuffer: Buffer[] = []; // Stores Raw PCM16 chunks
    private role: string = "";
    private company: string = "";
    private jobDescription: string = ""; 

    // 🧠 Track if we are currently inside a follow-up loop
    private isInsideFollowUp: boolean = false;
    
    // 🔒 NEW: Track if we are in the process of hanging up to prevent race conditions
    private isTerminating: boolean = false; 

    // 🕒 Silence Tracking
    private silenceTimer: NodeJS.Timeout | null = null;
    private hasWarnedSilence: boolean = false;

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
        if (this.isTerminating) return; 

        // 🟢 NEW: User is alive! Kill the silence timer immediately.
        this.stopSilenceTimer(); 
        this.hasWarnedSilence = false; 

        try {
            const cleanBase64 = base64Audio.split(',').pop() || "";
            const buffer = Buffer.from(cleanBase64, 'base64');
            this.audioBuffer.push(buffer);
        } catch (error) {
            console.error("❌ Error processing audio chunk:", error);
        }
    }

    public async commitUserAudio() {
        if (this.isTerminating) return;

        console.log(`User finished speaking. Processing audio for state: ${this.state}`);
        
        if (this.audioBuffer.length === 0) {
             console.log("⚠️ Audio buffer empty. Resetting Frontend.");
             this.ws.send(JSON.stringify({ type: 'ai_silence' }));
             return;
        }

        // 2. Transcribe
        const { text: rawText, isSilence } = await this.transcribeAudio();
        
        if (isSilence || rawText.trim().length === 0) {
             console.log("⚠️ Whisper detected silence. Resetting Frontend.");
             this.ws.send(JSON.stringify({ type: 'ai_silence' })); 
             this.audioBuffer = []; 
             this.startSilenceTimer(); // Restart timer if it was just silence
             return; 
        }

        console.log(`🗣️ Valid User Speech: "${rawText}"`);
        
        await this.saveTranscript('user', rawText);

        this.audioBuffer = []; 

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

    // --- 💾 DATABASE SAVER ---
    private async saveTranscript(sender: 'user' | 'assistant', text: string) {
        try {
            await prisma.transcriptEntry.create({
                data: {
                    sessionId: this.sessionId,
                    role: sender,
                    text: text,
                    createdAt: new Date()
                }
            });
            console.log(`💾 Saved ${sender} transcript to DB.`);
        } catch (err) {
            console.error("❌ Failed to save transcript:", err);
        }
    }

    // --- 👂 HELPER: TRANSCRIBE ---
    private async transcribeAudio(): Promise<{ text: string; isSilence: boolean }> {
        if (this.audioBuffer.length === 0) return { text: "", isSilence: true };
        const rawPCM = Buffer.concat(this.audioBuffer);
        const wavHeader = this.createWavHeader(rawPCM.length, 24000, 1, 16);
        const wavBuffer = Buffer.concat([wavHeader, rawPCM]);

        const tempFilePath = path.join(os.tmpdir(), `upload_${this.sessionId}_${Date.now()}.wav`);
        fs.writeFileSync(tempFilePath, wavBuffer);

        try {
            const response = await openai.audio.transcriptions.create({
                file: fs.createReadStream(tempFilePath),
                model: "whisper-1",
                response_format: "verbose_json", 
            }) as any; 

            const noSpeechProb = response.segments?.[0]?.no_speech_prob || 0;
            const text = response.text || "";

            console.log(`🔍 Analysis: Text="${text}", NoSpeechProb=${noSpeechProb.toFixed(2)}`);

            if (noSpeechProb > 0.6) { 
                return { text: "", isSilence: true };
            }
            return { text, isSilence: false };

        } catch (err) {
            console.error("Transcription failed:", err);
            return { text: "", isSilence: true };
        } finally {
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
        }
    }

    private createWavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
        const header = Buffer.alloc(44);
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4);
        header.write('WAVE', 8);
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28);
        header.writeUInt16LE(channels * (bitsPerSample / 8), 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40);
        return header;
    }

    // --- 🧠 SMART BANTER LOGIC ---
    private async handleSmallTalkResponse(userText: string) {
        const prompt = `
        You are a warm, professional Hiring Manager. 
        User said: "${userText}" (in response to "How are you?").
        Task: Warmly acknowledge, then transition to interview.
        🛑 DO NOT ask the first question yet.
        `;
        const response = await this.askGPT(prompt, 60);
        await this.speak(response);
        await new Promise(resolve => setTimeout(resolve, 2000));
        this.state = 'INTERVIEW';
        this.askCurrentQuestion();
    }

    // --- 🔴 SMART LOGIC: INTERVIEW (UPDATED FOR HOLD & CONTEXT) ---
    private async handleInterviewResponse(userText: string) {
        const currentQ = this.questions[this.currentQuestionIndex];

        if (this.isInsideFollowUp) {
            this.isInsideFollowUp = false;
            await this.moveToNextQuestion(userText); 
            return;
        }
        
        const systemPrompt = `
        Role: Interviewer. 
        Question: "${currentQ}"
        Answer: "${userText}"
        
        Task: Analyze the answer and pick a DECISION.
        
        1. **HOLD**: If user asks for time (e.g., "Give me a sec", "Thinking", "Yes", "Hold on", "Need a minute").
        2. **FOLLOW_UP**: If answer is vague/short but NOT asking for time.
        3. **MOVE_ON**: If answer is sufficient.
        
        Output JSON: { "decision": "HOLD" | "FOLLOW_UP" | "MOVE_ON", "content": "..." }
        `;

        try {
            const evaluation = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }],
                response_format: { type: "json_object" },
                temperature: 0.3
            });
            const result = JSON.parse(evaluation.choices[0].message.content || "{}");
            
            // --- NEW: HANDLE HOLD REQUEST ---
            if (result.decision === "HOLD") {
                console.log("⏸️ User asked for time. Pausing...");
                await this.speak("No problem, take your time.");
                // Start a LONG timer (60s) so we don't nag them immediately
                this.startSilenceTimer(60000); 
                return; 
            }

            if (result.decision === "FOLLOW_UP") {
                this.isInsideFollowUp = true; 
                await this.speak(result.content);
            } else {
                await this.moveToNextQuestion(null, result.content);
            }
        } catch (err) {
            await this.moveToNextQuestion("Thanks.");
        }
    }

    // --- 🌉 SMART NEUTRAL NAVIGATION HELPER ---
    private async moveToNextQuestion(prevUserText: string | null, bridge: string = "") {
        this.currentQuestionIndex++;

        if (this.currentQuestionIndex < this.questions.length) {
            const nextQ = this.questions[this.currentQuestionIndex];
            let finalBridge = bridge;
            
            if (!finalBridge && prevUserText) {
                const prompt = `
                You are a professional Interviewer.
                1. Candidate just said: "${prevUserText}"
                2. Next Question: "${nextQ}"
                Task: Generate a transition phrase (1 short sentence).
                🛑 STRICT RULE: DO NOT validate the answer (No "Great", "Impressive", "Solid").
                `;
                finalBridge = await this.askGPT(prompt, 30);
            }

            if (finalBridge) {
                await this.speak(finalBridge);
                await new Promise(resolve => setTimeout(resolve, 800)); 
            }
            await this.speak(nextQ);
        } 
        else {
            this.state = 'Q_AND_A';
            await this.speak("That covers the main questions I had.");
            await new Promise(resolve => setTimeout(resolve, 800));
            await this.speak("Before we wrap up, do you have any questions for me about the role or company?");
        }
    }

    private async handleQandAResponse(userText: string) {
        const isDone = await this.checkIfDone(userText);
        if (isDone) {
            this.state = 'CLOSING';
            await this.speak("Great! It was a pleasure meeting you. We will be in touch shortly. Have a great day!");
            setTimeout(() => { 
                this.terminateSession("Interview Complete"); 
            }, 5000); 
        } else {
            const prompt = `Hiring Manager for ${this.role}. Context: ${this.jobDescription}. User asked: "${userText}". Answer briefly and professionally. Ask "Any other questions?"`;
            const answer = await this.askGPT(prompt, 150);
            await this.speak(answer);
        }
    }

    private async askCurrentQuestion() {
        if (this.currentQuestionIndex < this.questions.length) {
            await this.speak(this.questions[this.currentQuestionIndex]);
        }
    }

    private async askGPT(systemPrompt: string, maxTokens: number = 100): Promise<string> {
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini", 
                messages: [{ role: "system", content: systemPrompt }],
                max_tokens: maxTokens
            });
            return response.choices[0].message.content || "Let's move on.";
        } catch (err) { console.error("GPT Error:", err); return "Let's continue."; }
    }

    private async checkIfDone(text: string): Promise<boolean> {
        try {
            const response = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: "Analyze if user text means 'No questions' or 'I am done'. Return TRUE if done." }, { role: "user", content: text }],
                max_tokens: 5
            });
            return response.choices[0].message.content?.toLowerCase().includes("true") || false;
        } catch (e) { return false; }
    }

    // --- 🕒 SILENCE MANAGEMENT (UPDATED: CONTEXT AWARE & FLEXIBLE) ---
    private startSilenceTimer(ms: number = 15000) {
        this.stopSilenceTimer(); // Clear existing

        this.silenceTimer = setTimeout(async () => {
            if (!this.hasWarnedSilence) {
                // FIRST TIMEOUT: Nudge the user naturally
                console.log("🕒 User is silent. Sending nudge...");
                this.hasWarnedSilence = true;
                
                let nudges: string[] = [];

                // 🧠 CONTEXT CHECK: Are we just starting or deep in the interview?
                if (this.state === 'INTRO' || this.state === 'SMALL_TALK') {
                    nudges = [
                        "Hello? Are you still there? I'll have to end the call shortly if there's no response.",
                        "I can't seem to hear you. If you're there, please say something so I keep the line open.",
                        "Just checking in—can you hear me?"
                    ];
                } else {
                    // INTERVIEW MODE: Explicitly offer time AND warn about auto-close
                    nudges = [
                        "Do you need a moment to think? Just let me know, otherwise I'll need to close the session in about 20 seconds.",
                        "I haven't heard from you. If you're thinking, just say 'I need a minute', otherwise I'll end the call to save time.",
                        "Just checking in—are you still with me?"
                    ];
                }

                const randomNudge = nudges[Math.floor(Math.random() * nudges.length)];
                
                await this.speak(randomNudge);
                
                // Restart timer for the "Kill" phase (give them 20 more seconds)
                this.startSilenceTimer(20000); 
            } else {
                // SECOND TIMEOUT: End the call politely
                console.log("🕒 User still silent. Ending session.");
                
                await this.speak("Since I haven't heard back, I'm going to end the interview now. You can try again later. Goodbye.");
                
                // --- Trigger clean hangup ---
                setTimeout(() => {
                    this.terminateSession("Silence Timeout");
                }, 4000);
            }
        }, ms); 
    }

    private stopSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    // --- 📴 HELPER: TERMINATE SESSION ---
    private terminateSession(reason: string) {
        if (this.isTerminating) return;
        this.isTerminating = true;
        
        this.stopSilenceTimer();

        console.log(`📴 Terminating Session: ${reason}`);

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ 
                type: 'call_ended', 
                reason: reason 
            }));
        }

        setTimeout(() => {
            if (this.ws.readyState === WebSocket.OPEN) {
                this.ws.close(1000, reason);
            }
        }, 1000);
    }

    // --- 🔊 HELPER: SPEAK ---
    private async speak(text: string) {
        if (this.isTerminating) return;

        console.log(`📤 Speaking: "${text}"`);
        this.stopSilenceTimer();
        await this.saveTranscript('assistant', text);

        this.ws.send(JSON.stringify({ type: 'ai_text', text }));

        if (!elevenlabs) {
            console.log("⚠️ ElevenLabs not active. Falling back to OpenAI.");
            try {
                const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: text });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));
            } catch (e) { console.error("OpenAI TTS Error:", e); }
            
            this.startSilenceTimer();
            return;
        }

        try {
            const audioStream = await elevenlabs.generate({
                voice: "e4WGXlfMTDZZRStMylyI", 
                text: text,
                model_id: "eleven_turbo_v2_5", 
                voice_settings: { stability: 0.35, similarity_boost: 0.75 }
            });

            const chunks: Buffer[] = [];
            for await (const chunk of audioStream) {
                chunks.push(Buffer.from(chunk));
            }
            const buffer = Buffer.concat(chunks);
            this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));

            this.startSilenceTimer();

        } catch (err) {
            console.error("ElevenLabs Error (Falling back to OpenAI):", err);
            try {
                const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: text });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));
            } catch (e) { console.error("OpenAI TTS Error:", e); }
            
            this.startSilenceTimer();
        }
    }
}