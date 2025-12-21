import WebSocket from 'ws';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// Configuration for the OpenAI Realtime API
const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
const SYSTEM_INSTRUCTION = `
You are a professional, friendly AI interviewer. 
Your goal is to conduct a structured yet natural interview.
- Speak clearly and concisely.
- Do not use markdown or complex formatting in speech.
- Be encouraging but professional.
- Focus on the candidate's experience and the job role.
`;

import { IInterviewSession } from './types';

export class OpenAIRealtimeSession implements IInterviewSession {
    private wsClient: WebSocket; // Connection to Frontend
    private wsOpenAI: WebSocket; // Connection to OpenAI
    private sessionId: string;
    private isOpenAIConnected: boolean = false;

    constructor(wsClient: WebSocket, sessionId: string) {
        this.wsClient = wsClient;
        this.sessionId = sessionId;

        console.log(`[Realtime] Initializing session: ${sessionId}`);

        // Initialize OpenAI WebSocket connection
        this.wsOpenAI = new WebSocket(OPENAI_WS_URL, {
            headers: {
                "Authorization": `Bearer ${process.env.OPENAI_API_KEY}`,
                "OpenAI-Beta": "realtime=v1",
            },
        });

        this.setupOpenAIHandlers();
    }

    private setupOpenAIHandlers() {
        this.wsOpenAI.on('open', () => {
            console.log(`[Realtime] Connected to OpenAI for session ${this.sessionId}`);
            this.isOpenAIConnected = true;
            this.sendSessionUpdate();
        });

        this.wsOpenAI.on('message', (data: WebSocket.Data) => {
            try {
                const event = JSON.parse(data.toString());
                this.handleOpenAIEvent(event);
            } catch (err) {
                console.error("[Realtime] Error parsing OpenAI message:", err);
            }
        });

        this.wsOpenAI.on('close', () => console.log("[Realtime] OpenAI Disconnected"));
        this.wsOpenAI.on('error', (err) => console.error("[Realtime] OpenAI Error:", err));
    }

    private sendSessionUpdate() {
        // Configure the session (Voice, Instructions, VAD)
        const event = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: SYSTEM_INSTRUCTION,
                voice: "shimmer", // 'shimmer' is the friendly female voice we chose
                input_audio_format: "pcm16", // Frontend sends raw PCM16 (base64 encoded)
                output_audio_format: "pcm16", // We want raw PCM16 back
                turn_detection: {
                    type: "server_vad", // Let OpenAI decide when user stops speaking
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500, // Quick turn-taking
                },
            },
        };
        this.wsOpenAI.send(JSON.stringify(event));
    }

    public handleUserAudio(base64Audio: string) {
        if (!this.isOpenAIConnected) return;

        // Forward audio chunk to OpenAI
        // Note: Frontend sends Base64, OpenAI expects Base64 in content.
        this.wsOpenAI.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64Audio
        }));
    }

    private handleOpenAIEvent(event: any) {
        switch (event.type) {
            case "response.audio.delta":
                // AI is speaking audio bytes (Base64)
                // Forward to frontend as 'audio_chunk'
                this.wsClient.send(JSON.stringify({
                    type: "audio_chunk",
                    audio: event.delta
                }));
                break;

            case "input_audio_buffer.speech_started":
                // User started speaking while AI was talking -> Interrupt!
                console.log("[Realtime] User interruption detected.");
                this.wsClient.send(JSON.stringify({ type: "interruption" }));
                this.wsOpenAI.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
                break;

            case "response.audio.done":
                console.log("[Realtime] AI finished speaking turn.");
                break;

            case "error":
                console.error("[Realtime] OpenAI Error Event:", event.error);
                break;
        }
    }

    // --- COMPATIBILITY METHODS (Matches RealtimeSession interface) ---

    public async commitUserAudio() {
        // If frontend explicitly says "I'm done" (e.g. button press), force a commit
        if (this.isOpenAIConnected) {
            console.log("[Realtime] Force committing audio buffer...");
            this.wsOpenAI.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        }
    }

    public handleAiPlaybackComplete() {
        // No-op for Realtime API (it handles its own state)
    }

    public close() {
        if (this.wsOpenAI.readyState === WebSocket.OPEN) {
            this.wsOpenAI.close();
        }
    }
}
