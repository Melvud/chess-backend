import * as fs from 'fs';
import * as path from 'path';

const BASE_URL = 'http://localhost:8080';
const TEST_IMAGE_PATH = path.join(process.cwd(), 'public', 'test_board.jpg');

async function testRecognitionConcurrency() {
    console.log('--- Starting Recognition Concurrency Test ---');

    if (!fs.existsSync(TEST_IMAGE_PATH)) {
        console.error(`Error: Test image not found at ${TEST_IMAGE_PATH}`);
        return;
    }

    console.log('Sending 3 concurrent recognition requests...');

    const startTime = Date.now();

    const sendRequest = async (id: number) => {
        const formData = new FormData();
        const buffer = fs.readFileSync(TEST_IMAGE_PATH);
        const blob = new Blob([buffer], { type: 'image/jpeg' });
        formData.append('image', blob, 'test_board.jpg');

        console.log(`Request ${id} sent...`);
        const response = await fetch(`${BASE_URL}/api/v1/scan`, {
            method: 'POST',
            body: formData
        });
        const data = await response.json();
        console.log(`Request ${id} finished. FEN: ${data.fen}`);
        return response;
    };

    try {
        // Send 3 requests at once
        const res1 = sendRequest(1);
        const res2 = sendRequest(2);
        const res3 = sendRequest(3);

        const responses = await Promise.all([res1, res2, res3]);
        const endTime = Date.now();

        console.log(`\nAll 3 requests completed in ${endTime - startTime}ms`);
        console.log('Responses OK:', responses.every(r => r.ok));

    } catch (error: any) {
        console.error('Test failed:', error.message);
    }
}

testRecognitionConcurrency();
