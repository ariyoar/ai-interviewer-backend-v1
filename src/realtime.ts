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

        this.handleIntro();
    }

    // --- 🟢 PHASE 1: INTRO ---
    private async handleIntro() {
        console.log("👋 Sending Intro Greeting...");
        const greeting = `Hi there! Thanks for joining. I'm the Hiring Manager for the ${this.role} role at ${this.company}. How are you doing today?`;
        await this.speak(greeting);
        this.state = 'SMALL_TALK'; 
    }

    // --- 👂 NEW: FRONTEND TRIGGER ---
    // ✅ FIX: Wait for frontend to finish audio before starting timer
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
             console.log("⚠️ Audio buffer empty. Resetting Frontend.");
             this.ws.send(JSON.stringify({ type: 'ai_silence' }));
             return;
        }

        const { text: rawText, isSilence } = await this.transcribeAudio();
        
        if (isSilence || rawText.trim().length === 0) {
             console.log("⚠️ Whisper detected silence. Resetting Frontend.");
             this.ws.send(JSON.stringify({ type: 'ai_silence' })); 
             this.audioBuffer = []; 
             // IMPORTANT: Restart timer here because user "attempted" to speak but failed
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
        const systemPrompt = `
        Role: Hiring Manager. Phase: Welcome/Small Talk.
        User said: "${userText}" (in response to "How are you?").
        
        Task: Analyze the user's intent.
        
        1. **HOLD**: If user asks for time (e.g., "Wait", "Hold on", "Give me a minute", "Not ready").
           - **RESPONSE RULE**: "No problem. Just keep in mind we have a limited slot. If you need more time to prepare, we can reschedule. Let me know."
        
        2. **CONTINUE**: If user answers normally.
           - **RESPONSE RULE**: Acknowledge politely (e.g., "Glad to hear it") and transition to "Let's get started."
           - 🛑 **DO NOT** summarize the user's answer. Just pivot.
        
        Output JSON: { "decision": "HOLD" | "CONTINUE", "response": "Text to speak" }
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
                // Manually start timer for Hold since user explicitly asked for time
                this.startSilenceTimer(60000); 
                return; 
            }

            await this.speak(responseText);
            await new Promise(resolve => setTimeout(resolve, 2000));

            this.state = 'INTERVIEW';
            this.askCurrentQuestion();

        } catch (err) {
            console.error("Small Talk Error:", err);
            await this.speak("Great. Let's dive in.");
            this.state = 'INTERVIEW';
            this.askCurrentQuestion();
        }
    }

    // --- 🔴 SMART LOGIC: INTERVIEW (UPDATED PROMPTS) ---
    private async handleInterviewResponse(userText: string) {
        const currentQ = this.questions[this.currentQuestionIndex];

        if (this.isInsideFollowUp) {
            this.isInsideFollowUp = false;
            await this.moveToNextQuestion(userText); 
            return;
        }
        
        // ✅ FIX: Strict Guardrails against grading
        const systemPrompt = `
        Role: You are the Interviewer speaking DIRECTLY TO THE CANDIDATE.
        Current Question: "${currentQ}"
        Candidate Answer: "${userText}"
        
        Task: Analyze the answer.
        
        1. **HOLD**: If user asks for time.
        2. **FOLLOW_UP**: If answer is vague/short.
        3. **MOVE_ON**: If answer is sufficient.
        
        **CRITICAL RULE FOR "CONTENT":**
        - Speak in the SECOND PERSON ("You").
        - **NEVER** use the Third Person ("The candidate", "He/She").
        - **NEVER** evaluate or grade them out loud (e.g., DO NOT say "The candidate showed good knowledge"). 
        - Instead, say: "I see, thanks for sharing that example." or "Understood."
        
        Output JSON: { "decision": "HOLD" | "FOLLOW_UP" | "MOVE_ON", "content": "Text to speak" }
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

    // --- 🌉 SMART NEUTRAL NAVIGATION HELPER ---
    private async moveToNextQuestion(prevUserText: string | null, bridge: string = "") {
        this.currentQuestionIndex++;

        if (this.currentQuestionIndex < this.questions.length) {
            const nextQ = this.questions[this.currentQuestionIndex];
            let finalBridge = bridge;
            
            if (!finalBridge && prevUserText) {
                // ✅ FIX: Strict Guardrails against grading
                const prompt = `
                You are a professional Interviewer speaking TO the candidate.
                1. Candidate said: "${prevUserText}"
                2. Next Question: "${nextQ}"
                
                Task: Generate a transition phrase.
                - 🛑 STRICT RULE: DO NOT grade the answer (No "Great answer", No "You demonstrated skill").
                - 🛑 STRICT RULE: Speak to them ("You"), not about them.
                - Use neutral acknowledgments: "Thanks for that context", "Understood", "Noted".
                `;
                finalBridge = await this.askGPT(prompt, 40);
            }

            if (finalBridge) {
                await this.speak(finalBridge);
                // Pause slightly between Bridge and Question
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
                        "Hello? Are you still there? I'll have to end the call shortly if there's no response.",
                        "Just checking in—can you hear me?"
                    ];
                } else {
                    nudges = [
                        "Do you need a moment to think? Just let me know, otherwise I'll need to close the session in about 20 seconds.",
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
        console.log(`📴 Terminating Session: ${reason}`);

        if (this.ws.readyState === WebSocket.OPEN) {
            this.ws.send(JSON.stringify({ type: 'call_ended', reason: reason }));
        }

        setTimeout(() => {
            if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, reason);
        }, 1000);
    }

    // --- 🔊 HELPER: SPEAK (UPDATED WITH STREAMING) ---
    private async speak(text: string) {
        if (this.isTerminating) return;

        console.log(`📤 Speaking: "${text}"`);
        
        // 1. Stop timer immediately
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
            // ✅ FIX: LOW LATENCY STREAMING
            const audioStream = await elevenlabs.generate({
                voice: "e4WGXlfMTDZZRStMylyI", 
                text: text,
                model_id: "eleven_turbo_v2_5", // Fastest model
                stream: true, // Force streaming
                voice_settings: { stability: 0.35, similarity_boost: 0.75 }
            });

            // ✅ Send chunks as they arrive!
            for await (const chunk of audioStream) {
                if (this.isTerminating) break; // Stop if user hung up
                const buffer = Buffer.from(chunk);
                this.ws.send(JSON.stringify({ 
                    type: 'ai_audio_chunk', 
                    audio: buffer.toString('base64') 
                }));
            }
            
            // 🛑 NOTE: We DO NOT start silence timer here anymore.
            // We wait for handleAiPlaybackComplete() to be called.

        } catch (err) {
            console.error("ElevenLabs Error:", err);
        }
    }
}