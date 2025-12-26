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
        Role: ${ctx.role} (${ctx.seniority})
        Expected Duration: ${ctx.durationMinutes} mins. Actual: ${ctx.actualDurationMinutes.toFixed(1)} mins.

        TRANSCRIPT:
        ${ctx.transcriptText}

        TASK:
        1. **Pacing**: Did they fill the time with quality content or fluff?
        2. **STAR Method**: For behavioral questions, did they use Situation-Task-Action-Result?
        3. **Redo**: Identify the 3 weakest answers and write a "Better Version" script for them.
        
        OUTPUT JSON:
        {
            "pacing_score": 1-10,
            "pacing_feedback": "string",
            "star_analysis": [ { "question": "string", "has_result": boolean, "feedback": "string" } ],
            "weakest_answers": [ { "original_summary": "string", "coached_version": "string (script)" } ]
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

        const prompt = `
        Act as a Senior Hiring Manager.
        Role: ${ctx.role} (${ctx.seniority})
        Rubric: ${rubric}

        TRANSCRIPT:
        ${ctx.transcriptText}

        TASK:
        1. **Score**: Assign 1-5 for each competency in the rubric.
        2. **Seniority Check**: Does their depth match ${ctx.seniority} level?
        3. **Red Flags**: Any contradictions, lies, or major gaps?

        OUTPUT JSON:
        {
            "overall_score": 1-5,
            "decision": "STRONG_HIRE" | "HIRE" | "NO_HIRE",
            "rubric_scores": [ { "category": "string", "score": number, "evidence": "string" } ],
            "seniority_analysis": "string",
            "red_flags": [ "string" ]
        }
        `;

        const response = await openai.chat.completions.create({
            model: "gpt-4o",
            messages: [{ role: "system", content: prompt }],
            response_format: { type: "json_object" }
        });

        return JSON.parse(response.choices[0].message.content || "{}");
    }
}
