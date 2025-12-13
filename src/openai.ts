// src/openai.ts
import OpenAI from 'openai';
import dotenv from 'dotenv';

dotenv.config();

export const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY, 
});

// ✅ FIX: Added the word "JSON" explicitly to rule #5
const SYSTEM_PROMPT = `
You are an expert hiring manager conducting a spoken interview.
Your goal is to generate 5-7 sharp, relevant interview questions based on the candidate's profile and the job context.

CRITICAL RULES:
1. CUSTOMIZE: If a Job Description (JD) is provided, ask specifically about skills mentioned there.
2. CONTEXT: If a Company/Industry is provided, frame questions relevant to that sector.
3. REGION: If a region is provided (e.g., "US", "Europe"), respect local professional norms.
4. STYLE: Keep questions conversational, short, and direct. No "Can you describe...". Use "Tell me about..." or "How do you...".
5. OUTPUT: Return ONLY a valid JSON object. Do not add markdown formatting like \`\`\`json. 

Example JSON Output:
{ "questions": ["Walk me through your experience with React.", "How do you handle tight deadlines?"] }
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

    let userMessage = `Candidate Role: ${context.role}\nExperience: ${context.experience}\nDuration: ${context.duration} mins.`;
    
    if (context.region) userMessage += `\nRegion: ${context.region}`;
    if (context.companyName) userMessage += `\nTarget Company: ${context.companyName}`;
    if (context.industry) userMessage += `\nIndustry: ${context.industry}`;
    
    if (context.resumeText) {
        userMessage += `\n\nCANDIDATE RESUME:\n${context.resumeText.slice(0, 3000)}`;
    }

    if (context.jobDescription) {
        userMessage += `\n\nJOB DESCRIPTION:\n${context.jobDescription.slice(0, 1000)}`;
    }

    // ✅ Added "Please return JSON." to the user message as a safety net
    userMessage += "\nPlease return the results in JSON format.";

    const completion = await openai.chat.completions.create({
        model: "gpt-4o", 
        messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userMessage }
        ],
        response_format: { type: "json_object" }, 
    });

    const content = completion.choices[0].message.content;
    if (!content) return [];

    try {
        const result = JSON.parse(content);
        return result.questions || [];
    } catch (err) {
        console.error("Failed to parse OpenAI JSON", err);
        return ["Tell me about yourself."]; 
    }
}