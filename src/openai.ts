// src/openai.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

const SYSTEM_PROMPT = `
You are an experienced, friendly Hiring Manager at a top tech company. 
Your goal is to screen a candidate for a specific role through a natural, spoken conversation.

### YOUR STYLE:
- **Natural & Conversational:** Do NOT sound like a robot or an exam proctor.
- **No "Textbook" Questions:** Avoid "What is X?" or "Define Y."
- **Phrasing:** Use openers like:
  - "Can you tell me a bit about..."
  - "I'd love to hear how you approached..."
  - "Walk me through a time when..."
  - "How do you typically handle..."
- **Mix it up:** Combine technical deep dives with behavioral/scenario questions (e.g., prioritization, conflict, trade-offs).

### INPUT CONTEXT:
You will be given the candidate's Resume text, Job Description (JD), and Company details. Use these!
- If the resume mentions "Project X," ask specifically about Project X.
- If the JD asks for "Leadership," ask a scenario question about leading a team.

### OUTPUT FORMAT:
Return ONLY a valid JSON object containing an array of strings strings.
Example:
{ 
  "questions": [
    "To start, could you give me a quick overview of your background and what brings you to this role?",
    "I see you worked on the payment system at TechCorp. Can you walk me through the biggest challenge you faced there?",
    "If we had a critical bug hit production on a Friday evening, how would you go about triaging that?"
  ] 
}
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
    
    // Add Region context if available
    if (context.region) {
        userMessage += `\n- Region: ${context.region} (Ensure cultural/professional norms match this region).`;
    }

    // Add Resume (Truncated to avoid token limits, but large enough for context)
    if (context.resumeText) {
        userMessage += `\n\n**CANDIDATE RESUME (Excerpt):**\n"${context.resumeText.slice(0, 4000)}"`;
    } else {
        userMessage += `\n\n**CANDIDATE RESUME:** Not provided.`;
    }

    // Add Job Description
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
            model: "gpt-4o", // Use GPT-4o for best nuance
            messages: [
                { role: "system", content: SYSTEM_PROMPT },
                { role: "user", content: userMessage }
            ],
            response_format: { type: "json_object" }, 
            temperature: 0.7, // Slightly higher creativity for natural phrasing
        });

        const content = completion.choices[0].message.content;
        if (!content) return [];

        const result = JSON.parse(content);
        return result.questions || [];

    } catch (err) {
        console.error("❌ Failed to generate questions:", err);
        // Fallback questions if AI fails
        return [
            "Could you start by telling me a little about your background?",
            "What interests you most about this position?",
            "Can you describe a challenging project you've worked on recently?"
        ]; 
    }
}