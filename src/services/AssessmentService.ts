import { PrismaClient } from '@prisma/client';
import OpenAI from 'openai';

const prisma = new PrismaClient();
const openai = new OpenAI();

interface AssessmentContext {
    sessionId: string;
    role: string;
    seniority: string;
    durationMinutes: number;
    actualDurationMinutes: number;
    transcriptText: string;
    resumeText: string;
    jobDescription: string;
    type: string;
    rubric?: string;
}

export class AssessmentService {

    // --- 1. CONTEXT AGGREGATOR ---
    static async getInterviewContext(sessionId: string): Promise<AssessmentContext | null> {
        const session = await prisma.interviewSession.findUnique({
            where: { id: sessionId },
            include: { transcript: { orderBy: { createdAt: 'asc' } } }
        }) as any; // Cast to any to bypass transient type errors until client regen completes

        if (!session) return null;

        // Join transcript into readable script
        const transcriptText = session.transcript.map((entry: any) => {
            const speaker = entry.role === 'interviewer' || entry.role === 'assistant' ? 'Interviewer' : 'Candidate';
            return `${speaker}: ${entry.text}`;
        }).join('\n');

        // Calculate actual duration
        let actualDurationMinutes = 0;
        if (session.startedAt && session.endedAt) {
            actualDurationMinutes = (session.endedAt.getTime() - session.startedAt.getTime()) / 60000;
        } else if (session.transcript.length > 0) {
            // Fallback: Time between first and last message
            const first = session.transcript[0].createdAt.getTime();
            const last = session.transcript[session.transcript.length - 1].createdAt.getTime();
            actualDurationMinutes = (last - first) / 60000;
        }

        return {
            sessionId: session.id,
            role: session.role,
            seniority: session.experience,
            durationMinutes: session.durationMinutes,
            actualDurationMinutes,
            transcriptText,
            resumeText: session.resumeText || "",
            jobDescription: session.jobDescription || "",
            type: session.type,
            rubric: session.rubric || undefined
        };
    }

    // --- 2. CANDIDATE COACHING PROCESSOR ---
    static async generateCoachingAssessment(sessionId: string) {
        const ctx = await this.getInterviewContext(sessionId);
        if (!ctx) throw new Error("Session not found");

        const prompt = `
        Act as an Elite Interview Coach. 

        # OBJECTIVE
        Provide a supportive, detailed post-interview debrief. Your goal is to help me 'ace' my next interview by transforming my current responses into high-impact, natural, and conversational narratives.

        # CONTEXT
        - Role: ${ctx.role}
        - Seniority: ${ctx.seniority}
        - Expected Duration: ${ctx.durationMinutes} mins. 
        - Actual Duration: ${ctx.actualDurationMinutes.toFixed(1)} mins.

        # TRANSCRIPT:
        ${ctx.transcriptText}

        # TASK:
        1. **Pacing**: Analyze if I filled the time with quality content. Provide advice on managing duration to show the depth expected for a ${ctx.seniority} role.
        2. **STAR Method**: Check for Situation-Task-Action-Result. Use "You" to provide mentorship.
        3. **The Golden Redo**: Identify my 3 weakest answers and write a "Golden Version" script for them. 

        # GOLDEN VERSION GUIDELINES (Conversational Integrity):
        - **Avoid Jargon**: Do not use "corporate speak" like 'orchestrated,' 'leveraged,' 'synergized,' or 'spearheaded.' 
        - **Tone**: Keep it "Impactful but Natural." Use language that a person actually uses in a professional conversation (e.g., "I took the lead on," "I put together a plan to," "I made sure that").
        - **Format**: Write in the first person ("I...").
        - **Evidence**: Include specific timestamps (e.g., [02:15]) for the original answer.
        - **Metrics**: Use placeholders like [X], [X]%, or $[X] for missing data.

        # OUTPUT JSON:
        {
            "pacing_score": 1-10,
            "pacing_feedback": "string",
            "communication_style_tips": ["string (How to keep it conversational but professional)"], 
            "star_analysis": [ 
                { 
                    "timestamp": "string",
                    "question": "string", 
                    "has_result": boolean, 
                    "feedback": "string (Constructive mentorship using 'You')" 
                } 
            ],
            "weakest_answers": [ 
                { 
                    "original_summary": "string", 
                    "coached_version": "string (The high-impact conversational script)",
                    "strategy_pro_tip": "string (Why this natural phrasing is effective for ${ctx.seniority})"
                } 
            ]
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: prompt }],
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content || "{}");
    }

    // --- 3. COMPANY SCREENING PROCESSOR ---
    static async generateScreeningAssessment(sessionId: string) {
        const ctx = await this.getInterviewContext(sessionId);
        if (!ctx) throw new Error("Session not found");

        // Use custom rubric or default if missing
        const rubric = ctx.rubric || "Standard Technical Competence, Communication, and Culture Fit.";

        const hiringManagerPrompt = `
        Act as a Senior Executive Recruiter and Talent Analyst.

        # OBJECTIVE
        Provide a rigorous, evidence-based internal assessment of the candidate for the Hiring Manager. This report must act as a professional audit, identifying hiring signals, risks, and seniority alignment.

        # CONTEXT
        - Role: ${ctx.role}
        - Seniority: ${ctx.seniority}
        - Rubric Constraints: ${rubric}
        - Expected Duration: ${ctx.durationMinutes} mins. 
        - Actual Duration: ${ctx.actualDurationMinutes.toFixed(1)} mins.

        # TRANSCRIPT WITH TIMESTAMPS:
        ${ctx.transcriptText}

        # TASK:
        1. **Executive Decision**: Provide an overall decision (STRONG_HIRE | HIRE | NO_HIRE | PROCEED_WITH_CAUTION).
        2. **Rubric Evaluation**: Adhere strictly to the scoring in the Rubric. Every score MUST include a timestamp reference.
        3. **Question-by-Question Assessment**: Review every exchange. Evaluate answer quality and identify the "Signal" (Positive/Negative).
        4. **Authenticity & Communication Audit**: Flag if the candidate relies too heavily on corporate jargon/buzzwords (e.g., 'leveraging,' 'synergy,' 'orchestrating') instead of providing clear, conversational evidence of their work.
        5. **Seniority & Behavioral Audit**: Analyze if the strategic depth matches a ${ctx.seniority} level.
        6. **Risk Analysis**: List Red Flags with Severity levels (Low/Medium/High) and timestamps.
        7. **Interview Playbook**: Suggest 3 targeted follow-up questions for the next round. Keep these questions direct and conversational.

        # EVALUATION GUIDELINES:
        - Refer to the person being interviewed as "The Candidate."
        - Be objective, critical, and direct. 
        - Use timestamps for EVERY piece of evidence.

        # OUTPUT JSON STRUCTURE:
        {
            "summary": {
                "decision": "string",
                "overall_score": "string | number",
                "justification": "string (Include key timestamps)",
                "communication_style_note": "string (Note on whether they were conversational or overly scripted/jargon-heavy)"
            },
            "rubric_breakdown": [ 
                { "category": "string", "score": "string | number", "evidence": "string", "timestamp": "string" } 
            ],
            "question_log": [
                {
                    "timestamp": "string",
                    "question": "string",
                    "answer_summary": "string",
                    "signal": "Positive | Negative | Neutral",
                    "critique": "string (Focus on the 'why' behind the signal)"
                }
            ],
            "seniority_check": {
                "matches_level": boolean,
                "analysis": "string"
            },
            "red_flags": [ 
                { "issue": "string", "severity": "Low | Medium | High", "details": "string", "timestamp": "string" } 
            ],
            "star_audit": { "clarity_score": 1-10, "missing_elements": ["string"], "analysis": "string" },
            "next_round_playbook": [
                { "topic": "string", "suggested_question": "string", "reason": "string" }
            ]
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: hiringManagerPrompt }],
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content || "{}");
    }
}
