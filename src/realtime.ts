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

// 🚨 SAFE INITIALIZATION
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
    private audioBuffer: Buffer[] = []; 
    private role: string = "";
    private company: string = "";
    private jobDescription: string = ""; 

    // ⏱️ TIME MANAGEMENT
    private sessionStartTime: number = Date.now();
    private sessionDurationMinutes: number = 30; // Default
    private hardLimitTimer: NodeJS.Timeout | null = null;

    private isInsideFollowUp: boolean = false;
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
        
        // ⏱️ FIX: Use 'durationMinutes' to match your Prisma Schema
        this.sessionDurationMinutes = session.durationMinutes || 30; 
        
        this.sessionStartTime = Date.now();
        console.log(`⏱️ Session started. Duration: ${this.sessionDurationMinutes} mins.`);

        // 🛡️ HARD FAILSAFE (Duration + 2 Minutes)
        const hardLimitMs = (this.sessionDurationMinutes + 2) * 60 * 1000;
        
        this.hardLimitTimer = setTimeout(async () => {
            console.log("⏱️ Hard time limit reached. Interrupting user.");
            this.stopSilenceTimer();

            // Politely Interrupt
            await this.speak("I apologize for the interruption, but we've hit our hard time limit for this session. Thank you for your time today. Goodbye!");
            
            setTimeout(() => {
                this.terminateSession("Hard Time Limit Exceeded");
            }, 6000);

        }, hardLimitMs);

        this.handleIntro();
    }

    // --- 🟢 PHASE 1: INTRO ---
    private async handleIntro() {
        console.log("👋 Sending Intro Greeting...");
        const greeting = `Hi there! Thanks for joining. I'm the Hiring Manager for the ${this.role} role at ${this.company}. How are you doing today?`;
        await this.speak(greeting);
        this.state = 'SMALL_TALK'; 
    }

    // --- 👂 FRONTEND TRIGGER ---
    public handleAiPlaybackComplete() {
        console.log("👂 Frontend finished playing audio. Starting silence timer now.");
        if (!this.isTerminating) {
            this.startSilenceTimer();
        }
    }

    // --- 🎤 HANDLE USER SPEECH ---
    public handleUserAudio(base64Audio: string) {
        if (this.isTerminating) return; 
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
             this.ws.send(JSON.stringify({ type: 'ai_silence' }));
             return;
        }

        const { text: rawText, isSilence } = await this.transcribeAudio();
        
        if (isSilence || rawText.trim().length === 0) {
             this.ws.send(JSON.stringify({ type: 'ai_silence' })); 
             this.audioBuffer = []; 
             this.startSilenceTimer(); 
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
        } catch (err) { console.error("DB Error:", err); }
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
            if (noSpeechProb > 0.6) return { text: "", isSilence: true };
            return { text, isSilence: false };
        } catch (err) {
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
        const systemPrompt = `
        Role: Hiring Manager. Phase: Welcome/Small Talk.
        User said: "${userText}" (in response to "How are you?").
        Task: Analyze intent.
        1. **HOLD**: If user asks for time. Response: "No problem. Keep in mind we have a limited slot. We can reschedule if needed."
        2. **CONTINUE**: If user answers normally. Response: Acknowledge politely and transition.
        Output JSON: { "decision": "HOLD" | "CONTINUE", "response": "..." }
        `;

        try {
            const evaluation = await openai.chat.completions.create({
                model: "gpt-4o-mini",
                messages: [{ role: "system", content: systemPrompt }],
                response_format: { type: "json_object" },
                temperature: 0.3
            });
            const result = JSON.parse(evaluation.choices[0].message.content || "{}");
            const decision = result.decision || "CONTINUE";
            const responseText = result.response || "Glad to hear it. Let's get started.";

            if (decision === "HOLD") {
                await this.speak(responseText); 
                this.startSilenceTimer(60000); 
                return; 
            }

            await this.speak(responseText);
            await new Promise(resolve => setTimeout(resolve, 2000));
            this.state = 'INTERVIEW';
            this.askCurrentQuestion();

        } catch (err) {
            await this.speak("Great. Let's dive in.");
            this.state = 'INTERVIEW';
            this.askCurrentQuestion();
        }
    }

    // --- 🔴 SMART LOGIC: INTERVIEW (WITH GUARDRAILS) ---
    private async handleInterviewResponse(userText: string) {
        const currentQ = this.questions[this.currentQuestionIndex];

        if (this.isInsideFollowUp) {
            this.isInsideFollowUp = false;
            await this.moveToNextQuestion(userText); 
            return;
        }
        
        const systemPrompt = `
        Role: Interviewer speaking DIRECTLY TO CANDIDATE.
        Question: "${currentQ}"
        Answer: "${userText}"
        Task: Analyze answer.
        1. **HOLD**: User asks for time.
        2. **FOLLOW_UP**: Vague/short answer.
        3. **MOVE_ON**: Sufficient answer.
        
        CRITICAL: 
        - Speak in SECOND PERSON ("You").
        - NEVER grade ("Good job").
        - Use neutral bridges ("Thanks for sharing").
        
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
            
            if (result.decision === "HOLD") {
                console.log("⏸️ User asked for time. Pausing...");
                await this.speak("No problem, take your time.");
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

    // --- 🌉 SMART NAVIGATION (UPDATED FOR TIME CHECK) ---
    private async moveToNextQuestion(prevUserText: string | null, bridge: string = "") {
        this.currentQuestionIndex++;

        // ⏱️ TIME CHECK!
        const elapsedMs = Date.now() - this.sessionStartTime;
        const remainingMs = (this.sessionDurationMinutes * 60 * 1000) - elapsedMs;
        const remainingMinutes = remainingMs / 1000 / 60;

        console.log(`⏱️ Time Check: ${remainingMinutes.toFixed(1)} mins remaining.`);

        // 🧠 DECISION LOGIC: Only ask if > 3 mins left
        if (this.currentQuestionIndex < this.questions.length && remainingMinutes > 3) {
            
            const nextQ = this.questions[this.currentQuestionIndex];
            let finalBridge = bridge;
            
            if (!finalBridge && prevUserText) {
                const prompt = `
                Interviewer to Candidate.
                Candidate said: "${prevUserText}"
                Next Question: "${nextQ}"
                Task: Transition phrase.
                🛑 NO grading. Speak to "You". Neutral tone.
                `;
                finalBridge = await this.askGPT(prompt, 40);
            }

            if (finalBridge) {
                await this.speak(finalBridge);
                await new Promise(resolve => setTimeout(resolve, 800)); 
            }
            await this.speak(nextQ);
        } 
        else {
            this.state = 'Q_AND_A';
            
            let closingBridge = "That covers the main questions I had.";
            
            if (remainingMinutes <= 3) {
                closingBridge = "Looking at the clock, I want to be respectful of your time, so let's pause the questions here.";
            }

            await this.speak(closingBridge);
            await new Promise(resolve => setTimeout(resolve, 800));
            await this.speak("Before we wrap up, do you have any questions for me about the role or company?");
        }
    }

    private async handleQandAResponse(userText: string) {
        const isDone = await this.checkIfDone(userText);
        
        // ⏱️ Double check time in Q&A
        const elapsedMs = Date.now() - this.sessionStartTime;
        const isOverTime = elapsedMs > (this.sessionDurationMinutes * 60 * 1000);

        if (isDone || isOverTime) {
            this.state = 'CLOSING';
            if (isOverTime) {
                await this.speak("We are officially out of time, but it was a pleasure meeting you. We'll be in touch shortly. Goodbye!");
            } else {
                await this.speak("Great! It was a pleasure meeting you. We will be in touch shortly. Have a great day!");
            }
            
            setTimeout(() => { 
                this.terminateSession("Interview Complete"); 
            }, 6000); 
        } else {
            const prompt = `Hiring Manager for ${this.role}. Context: ${this.jobDescription}. User asked: "${userText}". Answer briefly. Ask "Any other questions?"`;
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

    // --- 🕒 SILENCE MANAGEMENT ---
    private startSilenceTimer(ms: number = 15000) {
        this.stopSilenceTimer(); // Clear existing

        this.silenceTimer = setTimeout(async () => {
            if (!this.hasWarnedSilence) {
                // FIRST TIMEOUT: Nudge
                console.log("🕒 User is silent. Sending nudge...");
                this.hasWarnedSilence = true;
                
                let nudges: string[] = [];

                if (this.state === 'INTRO' || this.state === 'SMALL_TALK') {
                    nudges = [
                        "Hello? Are you still there?",
                        "Just checking in—can you hear me?"
                    ];
                } else {
                    nudges = [
                        "Do you need a moment to think?",
                        "Just checking in—are you still with me?"
                    ];
                }

                const randomNudge = nudges[Math.floor(Math.random() * nudges.length)];
                
                await this.speak(randomNudge);
                
                // Restart timer for the "Kill" phase
                this.startSilenceTimer(20000); 
            } else {
                // SECOND TIMEOUT: End the call
                console.log("🕒 User still silent. Ending session.");
                await this.speak("Since I haven't heard back, I'm going to end the interview now. You can try again later. Goodbye.");
                
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

    private terminateSession(reason: string) {
        if (this.isTerminating) return;
        this.isTerminating = true;
        this.stopSilenceTimer();
        if (this.hardLimitTimer) clearTimeout(this.hardLimitTimer);
        
        console.log(`📴 Terminating Session: ${reason}`);

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'call_ended', reason: reason }));
        }

        setTimeout(() => {
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, reason);
        }, 1000);
    }

    // --- 🔊 HELPER: SPEAK (STREAMING) ---
    private async speak(text: string) {
        if (this.isTerminating) return;

        console.log(`📤 Speaking: "${text}"`);
        this.stopSilenceTimer();
        await this.saveTranscript('assistant', text);
        this.ws.send(JSON.stringify({ type: 'ai_text', text }));

        // FALLBACK: OpenAI TTS
        if (!elevenlabs) {
            try {
                const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: text });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));
            } catch (e) { console.error("OpenAI TTS Error:", e); }
            return;
        }

        try {
            // STREAMING
            const audioStream = await elevenlabs.generate({
                voice: "e4WGXlfMTDZZRStMylyI", 
                text: text,
                model_id: "eleven_turbo_v2_5", 
                stream: true, 
                voice_settings: { stability: 0.35, similarity_boost: 0.75 }
            });

            for await (const chunk of audioStream) {
                if (this.isTerminating) break; 
                const buffer = Buffer.from(chunk);
                this.ws.send(JSON.stringify({ 
                    type: 'ai_audio_chunk', 
                    audio: buffer.toString('base64') 
                }));
            }
        } catch (err) {
            console.error("ElevenLabs Error:", err);
        }
    }
}