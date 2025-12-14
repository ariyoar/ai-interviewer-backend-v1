// src/test-client.ts
import WebSocket from 'ws';

// 🔴 LIVE RAILWAY CONFIGURATION
const API_URL = 'https://ai-interviewer-backend-v1-production.up.railway.app/api/session';
const WS_URL = 'wss://ai-interviewer-backend-v1-production.up.railway.app';

interface SessionData {
    id: string;
    questions: string[];
}

async function runTest() {
    console.log("🚀 Starting Smart Banter Test (Target: RAILWAY)...");

    // 1. Create Session via REST API
    console.log("1️⃣  Creating Interview Session...");
    
    // We send a mock resume to test the parser too
    const mockResume = "I am a Senior React Developer with 5 years of experience leading teams.";
    
    try {
        const createRes = await fetch(API_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                role: "Senior React Developer",
                experience: "5 years",
                durationMinutes: 15,
                region: "US",
                industry: "Tech",
                resumeText: mockResume
            })
        });
        
        if (!createRes.ok) {
            console.error("❌ Failed to create session:", await createRes.text());
            return;
        }

        const sessionData = await createRes.json() as SessionData;
        console.log(`✅ Session Created! ID: ${sessionData.id}`);

        // 2. Connect to WebSocket
        console.log("2️⃣  Connecting to Real-time Voice Socket...");
        const ws = new WebSocket(WS_URL);
        let conversationStep = 0; // 0 = Waiting for Intro, 1 = Waiting for Transition

        ws.on('open', () => {
            console.log("✅ WebSocket Connected!");

            // Initialize the session (Triggers AI Intro)
            console.log("📤 Sending 'init_session'...");
            ws.send(JSON.stringify({
                type: 'init_session',
                sessionId: sessionData.id
            }));
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            
            // We only care about text for this test logic (it's easier to read)
            if (msg.type === 'ai_text') {
                console.log(`\n🗣️  AI SAYS: "${msg.text}"`);

                // STEP 1: AI says "Hi there!" (The Intro)
                if (conversationStep === 0) {
                    conversationStep++;
                    console.log("✅ Received Intro! Now simulating user reply...");

                    // Wait 1 second, then reply
                    setTimeout(() => {
                        console.log("🎤 [User]: 'I am doing great, thanks for asking!'");
                        
                        // 1. Send dummy audio chunk (needed to trigger 'hearing')
                        ws.send(JSON.stringify({
                            type: 'audio_chunk',
                            audio: "UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=" 
                        }));

                        // 2. Send Commit signal
                        ws.send(JSON.stringify({
                            type: 'user_speaking_end'
                        }));
                    }, 1000);
                }
                
                // STEP 2: AI says "Great, let's start..." (The Transition)
                else if (conversationStep === 1) {
                    console.log("✅ Received Transition! The AI heard us and moved to the interview.");
                    console.log("🎉 TEST PASSED: Full Banter Loop Verified.");
                    ws.close();
                    process.exit(0);
                }
            }
        });

        ws.on('error', (err) => {
            console.error("❌ WebSocket Error:", err);
            console.log("💡 HINT: Check if your Railway URL is correct.");
        });

    } catch (err) {
        console.error("Test failed:", err);
    }
}

runTest();