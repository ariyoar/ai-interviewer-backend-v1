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
    private wsOpenAI!: WebSocket; // Connection to OpenAI
    private sessionId: string;
    private isOpenAIConnected: boolean = false;
    private role: string = "Software Engineer";
    private company: string = "our company";
    private resumeText: string = "";
    private jobDescription: string = "";
    private durationMinutes: number = 15;
    private experience: string = "Junior";
    private industry: string = "Technology";

    private region: string = "USA";
    private isGreetingPhase: boolean = true;

    constructor(wsClient: WebSocket, sessionId: string) {
        this.wsClient = wsClient;
        this.sessionId = sessionId;
        this.init();
    }

    private async init() {
        console.log(`[Realtime] Initializing session: ${this.sessionId}`);

        // 1. Fetch Context from DB
        const session = await prisma.interviewSession.findUnique({
            where: { id: this.sessionId }
        });

        if (session) {
            this.role = session.role;
            this.company = session.companyName || "our company";
            this.resumeText = session.resumeText || "No resume provided.";
            this.jobDescription = session.jobDescription || "No job description provided.";
            this.durationMinutes = session.durationMinutes || 15;
            this.experience = session.experience || "Not specified";
            this.industry = session.industry || "General Technology";
            this.region = session.region || "Global";
        }

        // 2. Initialize OpenAI WebSocket connection
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
            // 1. Start with VAD DISABLED to ensure greeting plays uninterrupted
            this.sendSessionUpdate(false);
        });

        this.wsOpenAI.on('message', (data: WebSocket.Data) => {
            try {
                const event = JSON.parse(data.toString());
                this.handleOpenAIEvent(event);
            } catch (err) {
                console.error("[Realtime] Error parsing OpenAI message:", err);
            }
        });

        // ... (close/error handlers)
    }

    private sendSessionUpdate(enableVAD: boolean = true) {
        console.log(`[Realtime] Sending session update. VAD: ${enableVAD}`);

        // --- 1. BUILD CONTEXT STRINGS CONDITIONALLY ---
        let contextSection = `
- **Interview Duration**: ${this.durationMinutes} minutes.
- **Region/Culture**: ${this.region}
- **Industry Context**: ${this.industry}
`;

        // Add JD if valid
        const hasJD = this.jobDescription && this.jobDescription !== "No job description provided.";
        if (hasJD) {
            contextSection += `- **Job Description**: "${this.jobDescription.slice(0, 1000)}..."\n`;
        }

        // Add Resume if valid
        const hasResume = this.resumeText && this.resumeText !== "No resume provided.";
        if (hasResume) {
            contextSection += `- **Candidate Resume**: "${this.resumeText.slice(0, 2000)}..."\n`;
        }

        // --- 2. BUILD INTERVIEW STRUCTURE CONDITIONALLY ---
        let experienceStep = "2. **Experience (40%)**: Ask about their past work experience in general.";
        if (hasResume) {
            experienceStep = "2. **Experience (40%)**: Ask specific questions based on their Resume (e.g. `I see you used X at Y...`).";
        }

        let deepDiveStep = `3. **Deep Dive (40%)**: Ask technical or behavioral questions relevant to the ${this.role} role.`;
        if (hasJD) {
            deepDiveStep = "3. **Deep Dive (40%)**: Ask technical or behavioral questions strictly based on the Job Description constraints.";
        }

        // --- 3. ASSEMBLE PROMPT ---
        const dynamicInstructions = `
# ROLE
You are an experienced Hiring Manager at ${this.company} in the ${this.industry} industry.
You are interviewing a candidate for the ${this.role} position (${this.experience} level) based in ${this.region}.
Your goal is to assess if the candidate is a good fit while providing a professional, engaging candidate experience.

# CONTEXT
${contextSection}

# INTERVIEW STRUCTURE
1. **Intro (1 min)**: Briefly welcome them and ask a casual icebreaker.
${experienceStep}
${deepDiveStep}
4. **Q&A (Remaining)**: Ask if they have questions for you. Answer them based on the company context.
5. **Closing**: Thank them and end the call.

# GUIDELINES
- **Time Management**: Keep track of the conversation flow. If you feel the time limit approaching, gently steer towards the Q&A section. "We have a few minutes left..."
- **Be Conversational**: Do NOT read a list of questions. React to what they say. Say "That's interesting" or "I see."
- **Reciprocity**: If they ask "How are you?", answer politely before moving on.
- **Short Answers**: Keep your responses concise (under 2 sentences usually) to let the candidate speak more.

# OUTPUT FORMAT
- Speak naturally. Use pauses (...) if you are thinking. 
- Do NOT output markdown.
`;

        // Configure the session
        const event = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: dynamicInstructions,
                voice: "alloy", // Switch to 'alloy' (safest default) to rule out voice issues
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                turn_detection: enableVAD ? {
                    type: "server_vad",
                    threshold: 0.5,
                    prefix_padding_ms: 300,
                    silence_duration_ms: 500,
                } : null,
            },
        };

        if (this.wsOpenAI && this.wsOpenAI.readyState === WebSocket.OPEN) {
            this.wsOpenAI.send(JSON.stringify(event));
        } else {
            console.warn("[Realtime] Warning: Attempted to send session update but OpenAI socket is not open.");
        }
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
        // 🔍 DEBUG: Log unexpected ends
        if (event.type === 'response.done' && !event.response?.output) {
            console.warn("[Realtime] Warning: Response done but might be empty?", JSON.stringify(event));
        }

        switch (event.type) {
            case "session.updated":
                console.log("[Realtime] Session configured successfully. Ready to start.");
                this.triggerGreeting();
                break;

            case "response.created":
                console.log("[Realtime] Response Created:", event.response?.id);
                this.wsClient.send(JSON.stringify({ type: "ai_response_start" }));
                break;

            case "response.audio.delta":
                // AI is speaking audio bytes (Base64)
                // Forward to frontend as 'ai_audio_chunk' (PROTOCOL FIX)
                this.wsClient.send(JSON.stringify({
                    type: "ai_audio_chunk",
                    audio: event.delta
                }));
                break;

            case "response.audio_transcript.delta":
                // AI is generating text (for captions)
                this.wsClient.send(JSON.stringify({
                    type: "ai_text",
                    text: event.delta
                }));
                break;

            case "input_audio_buffer.speech_started":
                // User started speaking while AI was talking -> Interrupt!
                console.log("[Realtime] User interruption detected.");
                this.wsClient.send(JSON.stringify({ type: "interruption" }));
                this.wsOpenAI.send(JSON.stringify({ type: "input_audio_buffer.clear" }));
                break;

            case "response.done":
                console.log("[Realtime] AI finished speaking turn.");
                this.wsClient.send(JSON.stringify({ type: "ai_response_done" }));

                // 🔄 VAD TOGGLE: If this was the greeting, now we enable VAD for the interview
                if (this.isGreetingPhase) {
                    console.log("[Realtime] Greeting finished. Enabling VAD for conversation...");
                    this.isGreetingPhase = false;
                    this.sendSessionUpdate(true); // Enable VAD
                }
                break;

            case "error":
                console.error("[Realtime] OpenAI Error Event:", event.error);
                break;

            default:
                // Log unhandled events to see if we are missing something
                // console.log(`[Realtime] Unhandled Event: ${event.type}`);
                break;
        }
    }

    // Moved greeting trigger to a method called AFTER session.updated
    private triggerGreeting() {
        const greeting = `Hi there! Thanks for joining. I'm the Hiring Manager for the ${this.role} role at ${this.company}. How are you doing today?`;

        console.log("[Realtime] Triggering Intro Greeting (Atomic VAD-Free)...");

        // 🕒 DELAY: Still keeping a small delay to be safe, but shorter now (250ms)
        setTimeout(() => {
            if (!this.isOpenAIConnected) return; // Safety check
            this.wsOpenAI.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"],
                    instructions: `Say exactly this with a friendly tone: "${greeting}"`
                }
            }));
        }, 250);
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
