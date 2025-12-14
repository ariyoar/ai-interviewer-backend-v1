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

    // --- 🧠 SMART BANTER LOGIC ---
    private async handleSmallTalkResponse(userText: string) {
        const prompt = `You are a friendly Hiring Manager. User said: "${userText}". Reply naturally, transition to interview. Keep it brief.`;
        const response = await this.askGPT(prompt, 60);
        await this.speak(response);
        this.state = 'INTERVIEW';
        this.askCurrentQuestion();
    }

    private async handleInterviewResponse(userText: string) {
        const acknowledgments = ["Thanks for sharing.", "That makes sense.", "I appreciate that context."];
        const bridge = acknowledgments[Math.floor(Math.random() * acknowledgments.length)];
        this.currentQuestionIndex++;
        if (this.currentQuestionIndex < this.questions.length) {
            await this.speak(`${bridge} ${this.questions[this.currentQuestionIndex]}`);
        } else {
            this.state = 'Q_AND_A';
            await this.speak("That covers my questions. Do you have any questions for me?");
        }
    }

    private async handleQandAResponse(userText: string) {
        const isDone = await this.checkIfDone(userText);
        if (isDone) {
            this.state = 'CLOSING';
            await this.speak("Great meeting you! We will be in touch. Have a great day!");
            setTimeout(() => { this.ws.send(JSON.stringify({ type: 'interview.complete' })); }, 5000); 
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

    // --- 🔊 HELPER: SPEAK (With Safety Fallback) ---
    private async speak(text: string) {
        console.log(`📤 Speaking: "${text}"`);
        this.ws.send(JSON.stringify({ type: 'ai_text', text }));

        // FALLBACK: Use OpenAI if ElevenLabs is not ready
        if (!elevenlabs) {
            console.log("⚠️ ElevenLabs not active. Falling back to OpenAI.");
            try {
                const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: text });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));
            } catch (e) { console.error("OpenAI TTS Error:", e); }
            return;
        }

        try {
            const audioStream = await elevenlabs.generate({
                voice: "j1r6AmrWb83gX3cYycRn", 
                text: text,
                model_id: "eleven_turbo_v2_5", 
                voice_settings: { stability: 0.5, similarity_boost: 0.75 }
            });

            const chunks: Buffer[] = [];
            for await (const chunk of audioStream) {
                chunks.push(Buffer.from(chunk));
            }
            const buffer = Buffer.concat(chunks);
            this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));

        } catch (err) {
            console.error("ElevenLabs Error (Falling back to OpenAI):", err);
            try {
                const mp3 = await openai.audio.speech.create({ model: "tts-1", voice: "alloy", input: text });
                const buffer = Buffer.from(await mp3.arrayBuffer());
                this.ws.send(JSON.stringify({ type: 'ai_audio_chunk', audio: buffer.toString('base64') }));
            } catch (e) { console.error("OpenAI TTS Error:", e); }
        }
    }
}