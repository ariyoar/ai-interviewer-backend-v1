// src/test-client.ts
import WebSocket from 'ws';

// 1. Define the API and WS URL
const API_URL = 'http://localhost:3000/api/session';
const WS_URL = 'ws://localhost:3000';

interface SessionData {
    id: string;
    questions: string[];
}

async function runTest() {
    console.log("🚀 Starting System Test...");

    // 2. Create a Session via REST API (With Resume & Region!)
    console.log("1️⃣  Creating Interview Session...");
    
    const mockResume = "I am a Senior React Developer with 5 years of experience at TechCorp. I optimized rendering by 40%.";
    
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
                resumeText: mockResume // Testing the new field!
            })
        });
        
        if (!createRes.ok) {
            console.error("❌ Failed to create session:", await createRes.text());
            return;
        }

        const sessionData = await createRes.json() as SessionData;
        console.log(`✅ Session Created! ID: ${sessionData.id}`);
        console.log(`🧠 Generated ${sessionData.questions.length} questions.`);
        console.log(`   Sample Q: "${sessionData.questions[0]}"`);

        // 3. Connect to WebSocket
        console.log("2️⃣  Connecting to Real-time Voice Socket...");
        const ws = new WebSocket(WS_URL);

        ws.on('open', () => {
            console.log("✅ WebSocket Connected!");

            // Initialize the session
            ws.send(JSON.stringify({
                type: 'init_session',
                sessionId: sessionData.id
            }));

            // Simulate "Speaking" (Sending a tiny dummy audio chunk)
            setTimeout(() => {
                console.log("3️⃣  Simulating User Speaking...");
                ws.send(JSON.stringify({
                    type: 'audio_chunk',
                    audio: "UklGRi4AAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQAAAAA=" // Empty WAV header
                }));
            }, 1000);

            // Simulate "Stop Speaking" (User releases spacebar)
            setTimeout(() => {
                console.log("4️⃣  User Finished Speaking (Sending Commit)...");
                ws.send(JSON.stringify({
                    type: 'user_speaking_end'
                }));
            }, 2000);
        });

        ws.on('message', (data) => {
            const msg = JSON.parse(data.toString());
            
            if (msg.type === 'ai_audio_chunk') {
                console.log("🎵 Received Audio Chunk from AI (It works!)");
                console.log("✅ TEST PASSED: Full Loop Verified.");
                process.exit(0);
            }
        });

        ws.on('error', (err) => {
            console.error("❌ WebSocket Error:", err);
        });

    } catch (err) {
        console.error("Test failed:", err);
    }
}

runTest();