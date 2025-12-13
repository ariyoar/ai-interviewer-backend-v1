// src/realtime.ts
import { WebSocket } from 'ws';
import { TranscriptEntry } from '@prisma/client';

// This class manages the connection between Your Backend <-> OpenAI Realtime API
export class RealtimeSession {
    private ws: WebSocket;
    private sessionId: string;
    private openAIWs: WebSocket | null = null;
    
    constructor(clientWs: WebSocket, sessionId: string) {
        this.ws = clientWs;
        this.sessionId = sessionId;
        this.initializeOpenAIConnection();
    }

    private initializeOpenAIConnection() {
        const url = "wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01";
        
        this.openAIWs = new WebSocket(url, {
            headers: {
                "Authorization": "Bearer " + process.env.OPENAI_API_KEY,
                "OpenAI-Beta": "realtime=v1",
            },
        });

        this.openAIWs.on('open', () => {
            console.log(`✅ Connected to OpenAI Realtime for session ${this.sessionId}`);
            this.setupSession();
        });

        this.openAIWs.on('message', (data) => {
            this.handleOpenAIMessage(data);
        });

        this.openAIWs.on('error', (err) => {
            console.error("OpenAI Socket Error:", err);
        });
    }

    private setupSession() {
        if (!this.openAIWs) return;
        
        // Configure the AI's voice and behavior
        const sessionConfig = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                voice: "verse", // or 'alloy', 'echo', 'shimmer'
                instructions: `
                    You are a friendly, professional interviewer. 
                    - Keep answers concise. 
                    - Acknowledge what the user said before moving on.
                    - Do not lecture.
                `,
            }
        };
        this.openAIWs.send(JSON.stringify(sessionConfig));
    }

    // 1. Receive Audio from User (Frontend -> Backend -> OpenAI)
    public handleUserAudio(base64Audio: string) {
        if (!this.openAIWs || this.openAIWs.readyState !== WebSocket.OPEN) return;

        // Append audio buffer to OpenAI's context
        this.openAIWs.send(JSON.stringify({
            type: "input_audio_buffer.append",
            audio: base64Audio
        }));
    }

    // 2. Commit the audio (Tell OpenAI "User is done talking, now reply")
    public commitUserAudio() {
        if (!this.openAIWs) return;
        this.openAIWs.send(JSON.stringify({ type: "input_audio_buffer.commit" }));
        this.openAIWs.send(JSON.stringify({ type: "response.create" }));
    }

    // 3. Handle OpenAI's Response (OpenAI -> Backend -> Frontend)
    private handleOpenAIMessage(data: any) {
        const event = JSON.parse(data.toString());

        // When OpenAI sends audio back
        if (event.type === 'response.audio.delta') {
            // Forward audio chunk to Frontend immediately
            this.ws.send(JSON.stringify({
                type: 'ai_audio_chunk',
                audio: event.delta
            }));
        }

        // When OpenAI sends the text transcript (for our DB)
        if (event.type === 'response.audio_transcript.done') {
            console.log("🤖 AI said:", event.transcript);
            // TODO: Save to Database (TranscriptEntry)
        }
    }
}