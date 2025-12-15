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

    // 🕒 NEW: Silence Tracking
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
        // 🟢 NEW: User is alive! Kill the silence timer immediately.
        this.stopSilenceTimer(); 
        this.hasWarnedSilence = false; 

        try {
            // 🚨 FIX: Strip the "data:audio/..." header if it exists
            const cleanBase64 = base64Audio.split(',').pop() || "";
            const buffer = Buffer.from(cleanBase64, 'base64');
            this.audioBuffer.push(buffer);
        } catch (error) {
            console.error("❌ Error processing audio chunk:", error);
        }
    }

    public async commitUserAudio() {
        console.log(`User finished speaking. Processing audio for state: ${this.state}`);
        
        if (this.audioBuffer.length === 0) {
             console.log("⚠️ Audio buffer empty. Resetting Frontend.");
             this.ws.send(JSON.stringify({ type: 'ai_silence' }));
             return;
        }

        // 2. Transcribe (Now creates a valid WAV file)
        const { text: rawText, isSilence } = await this.transcribeAudio();
        
        if (isSilence || rawText.trim().length === 0) {
             console.log("⚠️ Whisper detected silence. Resetting Frontend.");
             this.ws.send(JSON.stringify({ type: 'ai_silence' })); 
             this.audioBuffer = []; 
             return; 
        }

        console.log(`🗣️ Valid User Speech: "${rawText}"`);
        
        // 💾 SAVE USER ENTRY TO DB
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
                    text: text,        // Matches your DB column 'text'
                    createdAt: new Date() // Matches your DB column 'createdAt'
                }
            });
            console.log(`💾 Saved ${sender} transcript to DB.`);
        } catch (err) {
            console.error("❌ Failed to save transcript:", err);
        }
    }

    // --- 👂 HELPER: TRANSCRIBE (Raw PCM -> WAV) ---
    private async transcribeAudio(): Promise<{ text: string; isSilence: boolean }> {
        if (this.audioBuffer.length === 0) return { text: "", isSilence: true };

        // 1. Concatenate all raw PCM chunks
        const rawPCM = Buffer.concat(this.audioBuffer);

        // 2. Create a WAV Header (24kHz, 16-bit, Mono)
        const wavHeader = this.createWavHeader(rawPCM.length, 24000, 1, 16);
        
        // 3. Combine Header + PCM Data to make a valid WAV file
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

            // Standard Threshold
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

    // --- 🛠️ HELPER: CREATE WAV HEADER ---
    private createWavHeader(dataLength: number, sampleRate: number, channels: number, bitsPerSample: number): Buffer {
        const header = Buffer.alloc(44);
        
        // RIFF chunk descriptor
        header.write('RIFF', 0);
        header.writeUInt32LE(36 + dataLength, 4); // ChunkSize
        header.write('WAVE', 8);

        // fmt sub-chunk
        header.write('fmt ', 12);
        header.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)
        header.writeUInt16LE(1, 20); // AudioFormat (1 for PCM)
        header.writeUInt16LE(channels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), 28); // ByteRate
        header.writeUInt16LE(channels * (bitsPerSample / 8), 32); // BlockAlign
        header.writeUInt16LE(bitsPerSample, 34);

        // data sub-chunk
        header.write('data', 36);
        header.writeUInt32LE(dataLength, 40); // Subchunk2Size

        return header;
    }

    // --- 🧠 SMART BANTER LOGIC (UPDATED WITH PAUSE) ---
    private async handleSmallTalkResponse(userText: string) {
        const prompt = `
        You are a warm, professional Hiring Manager. 
        User said: "${userText}" (in response to "How are you?").
        
        Task: 
        1. Warmly acknowledge their response (e.g., "I'm really glad to hear that!" or "That's good to know.").
        2. Softly transition to the interview (e.g., "If you're ready, let's dive in.").
        
        🛑 STRICT RULE: DO NOT ask the first question yet. Just do the transition.
        `;
        
        const response = await this.askGPT(prompt, 60);
        await this.speak(response);

        // 2-second "Breather"
        await new Promise(resolve => setTimeout(resolve, 2000));

        this.state = 'INTERVIEW';
        this.askCurrentQuestion();
    }

    // --- 🔴 SMART LOGIC: INTERVIEW (UPDATED PROBING) ---
    private async handleInterviewResponse(userText: string) {
        const currentQ = this.questions[this.currentQuestionIndex];

        if (this.isInsideFollowUp) {
            console.log("🔄 User answered follow-up. Moving to next question.");
            this.isInsideFollowUp = false; // Reset flag
            await this.moveToNextQuestion(userText); 
            return;
        }

        console.log("🤔 Evaluating answer for follow-up potential...");
        
        const systemPrompt = `
        You are an experienced, professional Interviewer. 
        Current Question: "${currentQ}"
        Candidate Answer: "${userText}"
        
        Task: Decide if the answer is sufficient.
        - If it is VAGUE/SHORT: Generate a polite probe. **MUST start with an acknowledgment** (e.g., "I see. Could you clarify...", "Understood, but can you explain...").
        - If it is SUFFICIENT: Generate a NEUTRAL "Bridge" sentence acknowledging the answer (e.g., "Thanks for that context", "Understood", "Noted").
        - 🛑 DO NOT use validating words like "Great", "Impressive", "Solid".
        
        Output JSON ONLY:
        {
            "decision": "FOLLOW_UP" or "MOVE_ON",
            "content": "The text to speak"
        }
        `;

        try {
            const evaluation = await openai.chat.completions.create({
                model: "gpt-4o-mini", // Fast & Cheap
                messages: [{ role: "system", content: systemPrompt }],
                response_format: { type: "json_object" },
                temperature: 0.3
            });

            const result = JSON.parse(evaluation.choices[0].message.content || "{}");
            const decision = result.decision || "MOVE_ON";
            const content = result.content || "Thanks for sharing.";

            if (decision === "FOLLOW_UP") {
                console.log("🔍 Triggering Follow-Up Question");
                this.isInsideFollowUp = true; // Set flag so we don't loop forever
                await this.speak(content);
            } else {
                console.log("✅ Answer acceptable. Moving on.");
                // Combine the "Bridge" (content) with the Next Question
                await this.moveToNextQuestion(null, content);
            }

        } catch (err) {
            console.error("Evaluation Error:", err);
            await this.moveToNextQuestion("Thanks."); // Fallback
        }
    }

    // --- 🌉 SMART NEUTRAL NAVIGATION HELPER (UPDATED WITH PAUSE) ---
    private async moveToNextQuestion(prevUserText: string | null, bridge: string = "") {
        this.currentQuestionIndex++;

        // If we still have questions left
        if (this.currentQuestionIndex < this.questions.length) {
            const nextQ = this.questions[this.currentQuestionIndex];
            
            let finalBridge = bridge;
            
            if (!finalBridge && prevUserText) {
                // 🧠 DYNAMIC NEUTRAL BRIDGE GENERATION
                const prompt = `
                You are a professional Interviewer.
                1. Candidate just said: "${prevUserText}"
                2. Next Question: "${nextQ}"
                
                Task: Generate a transition phrase (1 short sentence).
                - 🛑 STRICT RULE: DO NOT validate the answer (No "Great", "Impressive", "Solid").
                - Be neutral and objective.
                - Examples: "Thanks for that context. Moving on...", "Understood. Regarding...", "Noted. Let's discuss..."
                `;
                finalBridge = await this.askGPT(prompt, 30);
            }

            // Speak the Bridge FIRST, then PAUSE, then ask the Question.
            if (finalBridge) {
                await this.speak(finalBridge);
                await new Promise(resolve => setTimeout(resolve, 800)); // 0.8s pause for impact
            }

            await this.speak(nextQ);
        } 
        else {
            // No questions left -> Q&A
            this.state = 'Q_AND_A';
            await this.speak("That covers the main questions I had.");
            await new Promise(resolve => setTimeout(resolve, 800)); // Brief pause
            await this.speak("Before we wrap up, do you have any questions for me about the role or company?");
        }
    }

    private async handleQandAResponse(userText: string) {
        const isDone = await this.checkIfDone(userText);
        if (isDone) {
            this.state = 'CLOSING';
            await this.speak("Great! It was a pleasure meeting you. We will be in touch shortly. Have a great day!");
            setTimeout(() => { this.ws.send(JSON.stringify({ type: 'interview.complete' })); }, 5000); 
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

    // --- 🕒 SILENCE MANAGEMENT (NEW NATURAL HANDLING) ---
    private startSilenceTimer() {
        this.stopSilenceTimer(); // Clear existing

        // 1. Set a timer for 15 seconds (The "Nudge")
        this.silenceTimer = setTimeout(async () => {
            if (!this.hasWarnedSilence) {
                // FIRST TIMEOUT: Nudge the user naturally
                console.log("🕒 User is silent. Sending nudge...");
                this.hasWarnedSilence = true;
                
                const nudges = [
                    "Just checking in—are you still with me?",
                    "Do you need a moment to think about that?",
                    "Let me know if you need me to repeat the question."
                ];
                const randomNudge = nudges[Math.floor(Math.random() * nudges.length)];
                
                await this.speak(randomNudge);
                
                // Restart timer for the "Kill" phase (give them 20 more seconds)
                this.startSilenceTimer(); 
            } else {
                // SECOND TIMEOUT: End the call politely
                console.log("🕒 User still silent. Ending session.");
                
                // 🛑 NATURAL KILL MESSAGE
                await this.speak("It looks like I might have lost you. I'm going to end the call for now, but feel free to reconnect whenever you're ready. Thanks.");
                
                // Wait for audio to finish playing, then close
                setTimeout(() => {
                    this.ws.close(1000, "User inactivity");
                }, 5000);
            }
        }, 15000); // 15 Seconds Wait Time
    }

    private stopSilenceTimer() {
        if (this.silenceTimer) {
            clearTimeout(this.silenceTimer);
            this.silenceTimer = null;
        }
    }

    // --- 🔊 HELPER: SPEAK (With Safety Fallback) ---
    private async speak(text: string) {
        console.log(`📤 Speaking: "${text}"`);
        
        // 🟢 Stop timer while AI is talking (don't interrupt self)
        this.stopSilenceTimer();

        // 💾 SAVE ASSISTANT ENTRY TO DB
        await this.saveTranscript('assistant', text);

        this.ws.send(JSON.stringify({ type: 'ai_text', text }));

        // FALLBACK: Use OpenAI if ElevenLabs is not ready
        if (!elevenlabs) {
            console.log("⚠️ ElevenLabs not active. Falling back to OpenAI.");
            try {
                const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: text });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));
            } catch (e) { console.error("OpenAI TTS Error:", e); }
            
            // Start listening again after fallback speech
            this.startSilenceTimer();
            return;
        }

        try {
            const audioStream = await elevenlabs.generate({
                voice: "e4WGXlfMTDZZRStMylyI", 
                text: text,
                // Using Multilingual V2 for better pacing/pauses as requested
                model_id: "eleven_multilingual_v2", 
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            });

            const chunks: Buffer[] = [];
            for await (const chunk of audioStream) {
                chunks.push(Buffer.from(chunk));
            }
            const buffer = Buffer.concat(chunks);
            this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));

            // 🟢 Start listening for user response after speech is sent
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