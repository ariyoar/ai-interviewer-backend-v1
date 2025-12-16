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

### 1. CONTEXT (CRITICAL):
- **The conversation has already started.** - You have already exchanged pleasantries (e.g., "How are you?", "Let's dive in.").
- **DO NOT** say "Hello," "Hi," "Thanks for joining," or "Welcome" again.
- **DO NOT** introduce yourself again.

### 2. SPOKEN LANGUAGE & PACING (To Fix Speed):
- **Write for the ear, not the eye.**
- **Use Punctuation for Pauses:** Use commas, hyphens (-), and periods frequently to force the voice to pause. This prevents the AI from rushing.
  - *Fast/Bad:* "Can you tell me about a time you had a conflict?"
  - *Natural/Paced:* "So... thinking back on your experience—can you tell me about a time you had to deal with a conflict?"
- **Use Softeners:** - *Bad:* "Describe your experience with SQL."
  - *Good:* "I see you've used SQL... how comfortable would you say you are with complex queries?"

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
    
    1. **FIRST QUESTION RULE:** The first question must be the "Tell me about yourself" question, but formatted as a **transition**. 
       - *BAD:* "Hi, thanks for joining. Tell me about yourself." (Do not do this).
       - *GOOD:* "So, to kick things off... could you give me a quick rundown of your background?"
    
    2. **SPECIFICITY:** The rest should be specific to their resume and the job description.
    
    3. **PACING:** Phrase them as if you are speaking slowly and thoughtfully. Use filler words (like "So," "Now," "I'm curious") to slow the delivery down.
    `;

    try {
        const completion = await openai.chat.completions.create({
            model: "gpt-4o", 
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage }
            ],
            response_format: { type: "json_object" }, 
            temperature: 0.7, // Lowered slightly to ensure instruction adherence
        });

        const content = completion.choices[0].message.content;
        if (!content) return [];

        const result = JSON.parse(content);
        return result.questions || [];

    } catch (err) {
        console.error("❌ Failed to generate questions:", err);
        return [
            "So, just to get us started... could you tell me a little bit about your background?",
            "I'm curious about what excites you most about this position?",
            "Looking at your past work... can you walk me through a challenging project you've handled?"
        ]; 
    }
}