// src/openai.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

const SYSTEM_PROMPT = `
You are an experienced Hiring Manager. 
Your goal is to screen a candidate efficiently through a **natural, spoken conversation.**

### 1. TONE & STYLE:
- **Conversational Professional:** You are a human, not a robot. Be polite but relaxed.
- **Objective:** Do not validate (avoid "Great answer!"). Just acknowledge and move on.
- **Spoken, Not Written:** Write exactly how a human *speaks*, not how they write emails.

### 2. SPOKEN LANGUAGE RULES (CRITICAL):
- **Use Contractions:** ALWAYS use "I'd," "You're," "Can't," "What's" instead of "I would," "You are," etc.
- **Softeners:** Start questions naturally.
  - *Bad:* "Describe your experience with SQL."
  - *Good:* "So, I see you've used SQL. How comfortable are you with complex queries?"
- **Simple Vocabulary:** Avoid stiff corporate jargon like "utilize," "leverage," or "synergize." Use "use," "use," and "work together."

### 3. DYNAMIC INPUTS:
- Use the Resume/JD to make questions specific.
- If the resume mentions "Project X", ask: "I was looking at Project X on your resume—what was your specific role there?"

### 4. OUTPUT FORMAT:
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
        userMessage += `\n- Region: ${context.region} (Ensure cultural norms match this region).`;
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
    1. The first question MUST be a soft opener (e.g., "Tell me a bit about yourself").
    2. The rest should be specific to their resume and the job description.
    3. **IMPORTANT:** Phrase them as if you are speaking to them face-to-face. Keep it conversational.
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage }
            ],
            response_format: { type: "json_object" }, 
            temperature: 0.8, // Slightly higher temp for more natural/varied phrasing
        });

        const content = completion.choices[0].message.content;
        if (!content) return [];

        const result = JSON.parse(content);
        return result.questions || [];

    } catch (err) {
        console.error("❌ Failed to generate questions:", err);
        return [
            "Could you start by telling me a little about your background?",
            "What excites you most about this position?",
            "Can you walk me through a challenging project you've worked on recently?"
        ]; 
    }
}