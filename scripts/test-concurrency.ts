import { execSync } from 'child_process';

const BASE_URL = 'http://localhost:8080';

async function testConcurrency() {
    console.log('--- Starting Concurrency Test ---');

    const FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

    const payload = {
        fens: [FEN, FEN],
        depth: 10,
        multiPv: 1
    };

    console.log('Sending 3 concurrent requests...');

    const startTime = Date.now();

    const sendRequest = () => fetch(`${BASE_URL}/api/v1/evaluate/positions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
    });

    try {
        const requests = [sendRequest(), sendRequest(), sendRequest()];
        const responses = await Promise.all(requests);
        const endTime = Date.now();

        console.log(`All 3 requests completed in ${endTime - startTime}ms`);
        console.log('Responses OK:', responses.every(r => r.ok));

        // On Windows, check for stockfish processes
        try {
            const tasklist = execSync('tasklist /FI "IMAGENAME eq stockfish.exe"').toString();
            const count = (tasklist.match(/stockfish.exe/g) || []).length;
            console.log(`Active stockfish processes: ${count}`);
        } catch (e) {
            console.log('Could not check tasklist (might not be on Windows or no processes found)');
        }

    } catch (error: any) {
        console.error('Test failed:', error.message);
    }
}

testConcurrency();
