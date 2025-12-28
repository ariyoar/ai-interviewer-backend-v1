import WebSocket from 'ws';
import { PrismaClient } from '@prisma/client';
import dotenv from 'dotenv';

dotenv.config();

const prisma = new PrismaClient();

// Configuration for the OpenAI Realtime API
const OPENAI_WS_URL = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview';
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
    private industry: string = ""; // Default to empty

    private region: string = "USA";
    private language: string = "English"; // 🌐 Default Language
    private isGreetingPhase: boolean = true;
    private startTime: number = Date.now(); // ⏱️ Start timer on instantiation
    private timeCheckInterval: NodeJS.Timeout | null = null; // ⏱️ Interval for time checks

    // 🧠 SMART BARGE-IN STATE
    private isAiSpeaking: boolean = false;
    private isInterruptionContext: boolean = false; // 🔒 Only filter short inputs if it was an interruption
    private potentialBackchannelId: string | null = null;

    private onClose: () => void;

    constructor(wsClient: WebSocket, sessionId: string, onClose: () => void) {
        this.wsClient = wsClient;
        this.sessionId = sessionId;
        this.onClose = onClose;
        // 🛑 REMOVED auto-init. logic moved to connect()
    }

    public setContext(context: any) {
        if (context.role) this.role = context.role;
        if (context.experience) this.experience = context.experience;
        if (context.jobDescription) this.jobDescription = context.jobDescription;
        if (context.resumeText) this.resumeText = context.resumeText;
        if (context.durationMinutes) this.durationMinutes = context.durationMinutes;
        if (context.industry) this.industry = context.industry;
        if (context.region) this.region = context.region;
        if (context.language) this.language = context.language; // 🌐 Set Language
        console.log(`[Realtime] Context injected manually for session ${this.sessionId}`);
    }

    public async connect() {
        console.log(`[Realtime] Connecting session: ${this.sessionId}`);

        // 1. If context is missing, try fetching from DB (Fallback)
        if (!this.jobDescription && !this.resumeText) {
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
                console.log("[Realtime] Context fetched from DB.");
            }
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
        const industryPhrase = this.industry ? `in the ${this.industry} industry` : "";
        const dynamicInstructions = `
# ROLE
You are an experienced Hiring Manager at ${this.company} ${industryPhrase}.
You are interviewing a candidate for the ${this.role} position (${this.experience} level) based in ${this.region}.
Your goal is to assess technical fit and behavioral traits objectively. Maintain a professional, neutral demeanor.

# CONTEXT
${contextSection}

# INTERVIEW STRUCTURE
1. **Intro (1 min)**: Briefly welcome them. Confirm their readiness. Skip the small talk unless initiated by the candidate.
${experienceStep}
${deepDiveStep}
4. **Q&A (Remaining)**: Ask if they have questions for you. Answer them based on the company context.
5. **Closing**: Thank them for their time and end the call.

# LANGUAGE INSTRUCTION (CRITICAL)
- **You must conduct this interview entirely in ${this.language}.**
- Do NOT switch languages unless explicitly requested by the candidate.
- If the candidate speaks a different language, politely remind them (in ${this.language}) that the interview is conducted in ${this.language}.

# AUTHORITY GUARDRAILS (CRITICAL)
- **You are the leader**: Do not ask the candidate what they want to talk about. You set the agenda.
- **Handling "Next Question"**: If the candidate says "Next question" or refuses to answer:
  - 🛑 **PUSH BACK ONCE**: "Actually, it's important for me to understand your experience in this specific area to complete my evaluation. Can you share any related example?"
  - ⚠️ **IF THEY REFUSE AGAIN**: Move on, but keep your tone professional and objective (e.g., "I've noted that we're moving past this topic.").
- **No Passive Validation**: Never use "All right" or "Understood" to just let a candidate avoid a question.

# GUIDELINES
- **Neutral Tone**: Do NOT be overly friendly or enthusiastic. Avoid words like "Awesome!", "Fantastic!", or "That's great!".
- **Concise Acknowledgment**: Acknowledge answers briefly (e.g., "I see.", "Noted.") before moving to the next question.
- **Probe Deeper**: If an answer is vague, ask follow-up questions for specific examples.
- **Time Management**: Keep the conversation moving. If time is running low, transition to the next section.
- **Reciprocity**: If they ask "How are you?", answer politely but briefly.

# TIME MANAGEMENT (CRITICAL)
- **Desired Duration**: ${this.durationMinutes} minutes.
- **Current Status**: [SYSTEM INJECTED TIME REMAINING]
- **PACE YOURSELF**: You MUST occupy the full interview duration.
- **IF AHEAD OF SCHEDULE**: Ask follow-up questions ("Can you give me an example?", "Why did you choose that approach?").
- **DO NOT** race to the next section if there is plenty of time left.

# ANTI-HALLUCINATION & VALIDATION RULES
1. **Short Answer Handling**:
   - If the candidate answers with 1-3 words (e.g., "Yes", "I did", "Okay"), or non-answers ("Um", "IDK"):
   - 🚫 **DO NOT** say "Great", "Excellent", "I see", or "That makes sense." (This is hallucinating a good answer).
   - ✅ **INSTEAD**: Ask for elaboration ("Could you tell me more about that?", "What do you mean specifically?").
2. **Neutral Validation**:
   - Use "Okay", "Noted".
   - Avoid excessive praise.

# OUTPUT FORMAT
- Speak naturally but professionally.
- Do NOT output markdown.
`;

        // Configure the session
        const event = {
            type: "session.update",
            session: {
                modalities: ["text", "audio"],
                instructions: dynamicInstructions, // 🛑 No more timeContext injection here
                voice: "alloy", // Switch to 'alloy' (safest default) to rule out voice issues
                input_audio_format: "pcm16",
                output_audio_format: "pcm16",
                turn_detection: enableVAD ? {
                    type: "server_vad",
                    threshold: 0.6, // Increased sensitivity threshold (was 0.5) to reduce false positives
                    prefix_padding_ms: 500, // Increased buffer (was 300)
                    silence_duration_ms: 1000, // WAIT 1 SECOND of silence before replying (was 500)
                } : null,
                input_audio_transcription: {
                    model: "whisper-1"
                }
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

    private async saveTranscript(role: 'candidate' | 'interviewer', text: string) {
        try {
            await prisma.transcriptEntry.create({
                data: {
                    sessionId: this.sessionId,
                    role: role,
                    text: text,
                    // createdAt is handled by @default(now())
                }
            });
            console.log(`[Realtime] Saved Transcript (${role}): "${text.slice(0, 50)}..."`);
        } catch (err) {
            console.error(`[Realtime] Failed to save transcript for ${role}:`, err);
        }
    }

    private handleOpenAIEvent(event: any) {
        // 🔍 DEBUG: Log expected vs unexpected ends
        if (event.type === 'response.done' && !event.response?.output) {
            console.log("[Realtime] Response finished (potentially empty).");
        }

        switch (event.type) {
            case "session.updated":
                console.log("[Realtime] Session configured successfully.");
                if (this.isGreetingPhase) {
                    this.triggerGreeting();
                }
                break;

            case "response.output_item.added":
                // 🧠 SMART BARGE-IN: If we flagged a backchannel, CANCEL the response immediately.
                // This event fires when AI creates a new item to respond.
                if (this.potentialBackchannelId) {
                    console.log(`[Realtime] 🚫 Cancelling response to backchannel.`);
                    this.wsOpenAI.send(JSON.stringify({ type: "response.cancel" }));
                    this.potentialBackchannelId = null; // Reset
                }
                break;

            case "response.created":
                console.log("[Realtime] Response Created:", event.response?.id);
                this.isAiSpeaking = true; // 🗣️ AI started a turn
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

            case "response.content_part.added":
                // Log content logic
                console.log("[Realtime] Content Part Added:", event.part);
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

                // ⏳ Clear Silence Timer (User is active)
                this.clearSilenceTimer();

                // 🧠 Capture Interruption Context
                // If AI was speaking, this counts as a Barge-In scenario.
                if (this.isAiSpeaking) {
                    this.isInterruptionContext = true;
                    console.log("[Realtime] Barging in on AI speech.");
                } else {
                    this.isInterruptionContext = false;
                }

                // 🛑 REMOVED MANUAL CLEAR per Smart Barge-In Logic
                break;

            case "response.done":
                console.log("[Realtime] AI finished speaking turn.");
                this.isAiSpeaking = false; // 🤫 AI finished
                this.wsClient.send(JSON.stringify({ type: "ai_response_done" }));

                // 🔄 VAD TOGGLE: If this was the greeting, now we enable VAD for the interview
                if (this.isGreetingPhase) {
                    console.log("[Realtime] Greeting finished. Enabling VAD for conversation...");
                    this.isGreetingPhase = false;
                    this.sendSessionUpdate(true); // Enable VAD
                    this.setupTimeTriggers();     // ⏱️ Start monitoring time
                }

                // ⏳ Start Silence Timer (waiting for user reply)
                this.startSilenceTimer();
                break;

            case "error":
                console.error("[Realtime] OpenAI Error Event:", JSON.stringify(event.error, null, 2));
                break;

            case "conversation.item.input_audio_transcription.completed":
                // 🗣️ User Speech Transcribed
                const userText = event.transcript || "";
                const wordCount = userText.trim().split(/\s+/).length;

                // 🧠 SMART BARGE-IN FILTER
                // Refined Logic based on User Request: "IF (User_Input_Word_Count < 3) THEN Discard"
                // ONLY if this was an interruption context.
                if (this.isInterruptionContext && wordCount < 3 && userText.trim().length > 0) {
                    console.log(`[Realtime] 🧹 Smart Barge-In: Detected backchannel ("${userText}"). Discarding.`);

                    // 1. Delete the item from context so AI doesn't see it
                    this.wsOpenAI.send(JSON.stringify({
                        type: "conversation.item.delete",
                        item_id: event.item_id
                    }));

                    // 2. Track this ID to cancel any response it triggered
                    this.potentialBackchannelId = event.item_id;

                    // 3. DO NOT SAVE to DB
                    this.isInterruptionContext = false; // Reset
                    return;
                }

                this.isInterruptionContext = false; // Reset context
                this.potentialBackchannelId = null; // Clear flag if it was a real turn

                if (userText && userText.trim().length > 0) {
                    this.saveTranscript('candidate', userText);
                }
                break;

            case "response.audio_transcript.done":
                // 🤖 AI Speech Transcribed
                const aiText = event.transcript;
                if (aiText && aiText.trim().length > 0) {
                    this.saveTranscript('interviewer', aiText);
                }
                break;

            default:
                break;
        }
    }

    // Moved greeting trigger to a method called AFTER session.updated
    private triggerGreeting() {
        console.log("[Realtime] Triggering Intro Greeting (Conversation Strategy)...");

        // 🕒 DELAY: Small delay to ensure session readiness
        setTimeout(() => {
            if (!this.isOpenAIConnected) return; // Safety check

            // 1. Clear Buffer
            this.wsOpenAI.send(JSON.stringify({ type: "input_audio_buffer.clear" }));

            // 2. Inject System Command to Start (Avoids "Thank you for confirming..." robot response)
            this.wsOpenAI.send(JSON.stringify({
                type: "conversation.item.create",
                item: {
                    type: "message",
                    role: "system",
                    content: [{ type: "input_text", text: "The user has joined the call. Start the interview now. Introduce yourself briefly and ask the first question." }]
                }
            }));

            // 3. Ask for Response
            this.wsOpenAI.send(JSON.stringify({
                type: "response.create",
                response: {
                    modalities: ["text", "audio"]
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
        if (this.timeCheckInterval) clearInterval(this.timeCheckInterval);
        if (this.wsOpenAI.readyState === WebSocket.OPEN) {
            this.wsOpenAI.close();
        }
    }

    // --- ⏱️ SURGICAL TIMEKEEPER LOGIC ---

    private setupTimeTriggers() {
        if (this.timeCheckInterval) clearInterval(this.timeCheckInterval);

        console.log("[Realtime] Starting Active Timekeeper...");

        this.timeCheckInterval = setInterval(() => {
            const elapsedMinutes = (Date.now() - this.startTime) / 60000;
            const remainingMinutes = Math.max(0, this.durationMinutes - elapsedMinutes);

            // console.log(`[Realtime] Time Check: ${remainingMinutes.toFixed(1)} mins left.`);

            // Triggers at specific thresholds (with a small buffer to avoid double triggering)
            // e.g., if reamining is between 14.9 and 15.1... actually, simpler to strict check?
            // Better: just trigger every minute or so? User asked for thresholds.
            // Let's interpret "surgical" as "periodic reminder".

            // Logic: Inject update every 2 minutes or at critical milestones?
            // User Ex: "5 minutes remaining, 1 minute remaining"

            // Critical Thresholds Logic (Stateful check would be better but keeping it simple)
            const isCriticalMap = [15, 10, 5, 3, 1];

            // We need to track which thresholds we've already fired. 
            // Simplified approach: Just verify if we are CLOSE to a whole number threshold we care about.
            const threshold = isCriticalMap.find(t => Math.abs(remainingMinutes - t) < 0.05); // +/- 3 seconds window

            if (threshold) {
                // Ensure we don't spam? (Interval is 1m, so collision unlikely if logic correct)
                // Actually, setInterval(1 min) might drift. 
                // Let's use a explicit "lastInjectedMinute" tracker if we wanted perfection.
                // For now, let's inject a generic status every 2 minutes + the final minute.
                this.injectSystemMessage(`[SYSTEM STATUS: ${Math.ceil(remainingMinutes)} minutes remaining. PACE YOURSELF.]`);
            } else if (remainingMinutes < 1 && remainingMinutes > 0.1) {
                // Final countdown (every 30s?)
                this.injectSystemMessage(`[CRITICAL: LESS THAN 1 MINUTE. WRAP UP.]`);
            }

        }, 60000); // Check every minute
    }

    private injectSystemMessage(text: string) {
        if (!this.isOpenAIConnected) return;

        console.log(`[Realtime] 💉 Injecting System Message: "${text}"`);

        this.wsOpenAI.send(JSON.stringify({
            type: "conversation.item.create",
            item: {
                type: "message",
                role: "system", // Use 'system' role
                content: [{ type: "input_text", text: text }]
            }
        }));
    }

    // --- ⏳ SILENCE TIMEOUT LOGIC ---

    private silenceTimeout: NodeJS.Timeout | null = null;
    private silenceStage: number = 0; // 0=None, 1=Nudged, 2=Warned

    private startSilenceTimer() {
        this.clearSilenceTimer(false); // Clear timer but don't reset stage yet (logic handles refs)

        // Only start if VAD is active (not continuously greeting phase)
        if (this.isGreetingPhase || !this.isOpenAIConnected) return;

        // Determine Duration based on Stage
        // Stage 0 -> 20s -> Nudge
        // Stage 1 -> 20s -> Warn (Ending in 30s)
        // Stage 2 -> 30s -> Terminate
        let duration = 20000;
        if (this.silenceStage === 2) duration = 30000;

        console.log(`[Realtime] ⏳ Starting Silence Timer (Stage ${this.silenceStage}): ${duration}ms`);

        this.silenceTimeout = setTimeout(() => {
            this.handleSilenceTimeout();
        }, duration);
    }

    private handleSilenceTimeout() {
        console.log(`[Realtime] ⏳ Silence Timeout Triggered (Stage ${this.silenceStage})`);

        if (this.silenceStage === 0) {
            // Stage 0 -> 1: Polite Nudge
            this.injectSystemMessage("The candidate has been silent for 20 seconds. Gently ask if they are still there or if they need a moment.");
            this.forceAiResponse();
            this.silenceStage = 1;
            this.startSilenceTimer(); // Restart for next stage

        } else if (this.silenceStage === 1) {
            // Stage 1 -> 2: Final Warning
            this.injectSystemMessage("The candidate is still silent. State clearly: 'Since I haven't heard from you, I will end the call in 30 seconds if there is no response.'");
            this.forceAiResponse();
            this.silenceStage = 2; // Next timeout will look for 30s
            this.startSilenceTimer();

        } else if (this.silenceStage === 2) {
            // Stage 2 -> End: Terminate
            console.log("[Realtime] 🛑 max silence reached. Terminating session.");
            // Assuming `activeSessions` is a Map passed to or accessible by this class instance
            // and `sessionId` is a property of this class.
            // If not, this line will need adjustment based on how sessions are managed.
            // For example, if this class is the session itself, it might emit an event.
            // For now, assuming `activeSessions` is available.
            // this.activeSessions.delete(this.sessionId); // Uncomment and adapt if session management is external
            this.wsClient.send(JSON.stringify({ type: "error", message: "Session ended due to inactivity." }));
            this.close();
            this.onClose(); // Notify parent to remove from map
        }
    }

    private forceAiResponse() {
        this.wsOpenAI.send(JSON.stringify({
            type: "response.create",
            response: { modalities: ["text", "audio"] }
        }));
    }

    private clearSilenceTimer(resetStage: boolean = true) {
        if (this.silenceTimeout) {
            clearTimeout(this.silenceTimeout);
            this.silenceTimeout = null;
        }
        if (resetStage) {
            this.silenceStage = 0;
        }
    }
}
