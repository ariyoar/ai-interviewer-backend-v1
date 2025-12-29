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
        Provide a supportive, detailed post-interview debrief. Transform my current responses into high-impact, natural narratives. Use a helpful, mentor-like tone.

        # CONTEXT
        - Role: ${ctx.role}
        - Seniority: ${ctx.seniority}
        - Expected Duration: ${ctx.durationMinutes} mins. 
        - Actual Duration: ${ctx.actualDurationMinutes.toFixed(1)} mins.

        # TRANSCRIPT:
        ${ctx.transcriptText}

        # TASK:
        1. **Executive Coaching Summary**: Summarize my overall performance. Identify my 2-3 "Superpowers" and my 2-3 "Critical Growth Areas."
        2. **Chronological Question Breakdown**: Review every single question in the transcript. For each:
           - Provide the **verbatim answer** I gave.
           - Assign a **Signal** (Positive, Neutral, Warning, Negative).
           - Provide a **detailed description** of the "vibe" and what that answer signaled to the interviewer.
        3. **The Golden Redo**: Identify the 3 weakest answers. For each, write a "Golden Version" script using first-person, natural language (no jargon like 'leveraged' or 'orchestrated').
        4. **Action Plan**: Provide a 3-step concrete plan for what I should do before my next interview to improve.

        # OUTPUT JSON:
        {
            "executive_summary": {
                "overall_performance": "string",
                "superpowers": ["string"],
                "growth_areas": ["string"],
                "readiness_score": "1-100"
            },
            "pacing_and_style": {
                "score": 1-10,
                "feedback": "string",
                "tips": ["string"]
            },
            "chronological_analysis": [
                {
                    "timestamp": "string",
                    "question": "string",
                    "your_verbatim_answer": "string",
                    "signal": "Positive | Neutral | Warning | Negative",
                    "detailed_critique": "string"
                }
            ],
            "top_3_redos": [ 
                { 
                    "question": "string", 
                    "why_it_failed": "string",
                    "golden_version": "string",
                    "strategy_pro_tip": "string"
                } 
            ],
            "action_plan": {
                "summary": "string",
                "steps": ["string"]
            }
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: prompt }],
            response_format: { type: "json_object" }
        });

        const rawJson = JSON.parse(response.choices[0].message.content || "{}");

        // 🛡️ SAFEGUARD: Ensure all arrays exist to prevent Frontend Crashes (TypeError: cannot read 'map')
        return {
            executive_summary: {
                overall_performance: rawJson.executive_summary?.overall_performance || "No data available.",
                superpowers: rawJson.executive_summary?.superpowers || [],
                growth_areas: rawJson.executive_summary?.growth_areas || [],
                readiness_score: rawJson.executive_summary?.readiness_score || "N/A"
            },
            pacing_and_style: {
                score: rawJson.pacing_and_style?.score || 0,
                feedback: rawJson.pacing_and_style?.feedback || "No feedback generated.",
                tips: rawJson.pacing_and_style?.tips || []
            },
            chronological_analysis: rawJson.chronological_analysis || [],
            top_3_redos: rawJson.top_3_redos || [],
            action_plan: {
                summary: rawJson.action_plan?.summary || "No plan generated.",
                steps: rawJson.action_plan?.steps || []
            }
        };

        // 💾 PERSISTENCE: Save to DB
        await prisma.interviewSession.update({
            where: { id: sessionId },
            data: { coachingReport: finalJson as any }
        });

        return finalJson;
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

        const finalJson = JSON.parse(response.choices[0].message.content || "{}");

        // 💾 PERSISTENCE: Save to DB
        await prisma.interviewSession.update({
            where: { id: sessionId },
            data: { screeningReport: finalJson as any }
        });

        return finalJson;
    }
}
