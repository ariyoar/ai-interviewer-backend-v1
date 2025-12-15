// src/openai.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

// src/openai.ts

const SYSTEM_PROMPT = `
You are an experienced, professional Hiring Manager at a top tech company. 
Your goal is to screen a candidate efficiently and objectively.

### 1. TONE & STYLE:
- **Professional & Neutral:** Do not be overly enthusiastic. Do not use exclamation marks.
- **Direct but Polite:** Ask clear, open-ended questions.
- **Avoid Validation:** Do not write questions that imply the candidate is already doing well.
- **Natural Phrasing:** Use "I'd like to understand..." or "Could you walk me through..." instead of stiff "Describe a time" commands.

### 2. DYNAMIC INPUTS:
- Use the Resume/JD to make questions specific.
- Example: "Your resume mentions Project X. What was your specific contribution to that?"

### 3. OUTPUT FORMAT:
Return ONLY a valid JSON object containing an array of strings.
{ "questions": ["Question 1", "Question 2"...] }
`;

export async function generatePrimaryQuestions(
    context: {
        role: string,
        experience: string,
        duration: number,
        jobDescription?: string,
        companyName?: string,
        industry?: string,
        region?: string,
        resumeText?: string
    }
): Promise<string[]> {
    
    console.log(`🧠 Generating questions for ${context.role}...`);

    let userMessage = `
    **CONTEXT:**
    - Role: ${context.role}
    - Experience Level: ${context.experience}
    - Company Name: ${context.companyName || "Unknown"}
    - Industry: ${context.industry || "General"}
    - Interview Duration: ${context.duration} minutes (Aim for ~${Math.max(3, Math.floor(context.duration / 3))} questions)
    `;
    
    if (context.region) {
        userMessage += `\n- Region: ${context.region} (Ensure cultural/professional norms match this region).`;
    }

    if (context.resumeText) {
        userMessage += `\n\n**CANDIDATE RESUME (Excerpt):**\n"${context.resumeText.slice(0, 4000)}"`;
    } else {
        userMessage += `\n\n**CANDIDATE RESUME:** Not provided.`;
    }

    if (context.jobDescription) {
        userMessage += `\n\n**JOB DESCRIPTION (Excerpt):**\n"${context.jobDescription.slice(0, 1500)}"`;
    }

    userMessage += `
    \n**TASK:**
    Generate a list of interview questions. 
    1. The first question MUST be a soft opener (e.g., "Tell me about yourself").
    2. The rest should be specific to their resume and the job description.
    3. Make them sound like a human talking, not a list of requirements.
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage }
            ],
            response_format: { type: "json_object" }, 
            temperature: 0.7, 
        });

        const content = completion.choices[0].message.content;
        if (!content) return [];

        const result = JSON.parse(content);
        return result.questions || [];

    } catch (err) {
        console.error("❌ Failed to generate questions:", err);
        return [
            "Could you start by telling me a little about your background?",
            "What interests you most about this position?",
            "Can you describe a challenging project you've worked on recently?"
        ]; 
    }
}