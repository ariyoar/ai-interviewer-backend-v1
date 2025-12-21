import WebSocket from 'ws';

// ---------------------------------------------------------
// CONFIGURATION
// ---------------------------------------------------------
// const WS_URL = 'ws://localhost:8080'; // Local
const WS_URL = 'wss://ai-interviewer-backend-v1-production.up.railway.app'; // Production
// ---------------------------------------------------------

const sessionId = 'test-cli-' + Date.now();
console.log(`Connecting to ${WS_URL} with session ${sessionId}...`);

const ws = new WebSocket(WS_URL);

ws.on('open', () => {
    console.log('✅ Connected to Backend WebSocket.');

    // 1. Send Initialization
    // The backend looks up this ID in Prisma. If not found, it defaults to generic context.
    const initPayload = {
        type: 'init_session',
        sessionId: sessionId, // Random ID will trigger default "Software Engineer" context
        useRealtimeApi: true
    };

    console.log('📤 Sending init_session:', initPayload);
    ws.send(JSON.stringify(initPayload));
});

ws.on('message', (data: WebSocket.Data) => {
    try {
        const event = JSON.parse(data.toString());

        // Pretty print audio chunks to avoid flooding console with base64
        if (event.type === 'ai_audio_chunk') {
            console.log(`🔊 [AUDIO] Recv: ${event.audio.length} chars (Base64)`);
        } else if (event.type === 'ai_text') {
            console.log(`📝 [TEXT]  Recv: "${event.text}"`);
        } else if (event.type === 'debug_log') {
            console.log(`🔍 [DEBUG] ${event.message}`, event.data ? JSON.stringify(event.data, null, 2) : '');
        } else {
            console.log(`📩 [EVENT] Recv:`, event);
        }

        // If we get response done, we can simulate user shutting up or just waiting
        if (event.type === 'ai_response_done') {
            console.log('✅ Response Complete.');
            // Optional: Close after first turn to verify success
            // setTimeout(() => { ws.close(); process.exit(0); }, 1000);
        }

    } catch (e) {
        console.log('Unknown Message:', data.toString());
    }
});

ws.on('close', () => console.log('❌ Disconnected from Backend.'));
ws.on('error', (err) => console.error('⚠️ WebSocket Error:', err));
