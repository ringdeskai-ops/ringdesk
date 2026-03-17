const request = require('supertest');
const axios = require('axios');
const MockAdapter = require('axios-mock-adapter');
const app = require('./app');

const mock = new MockAdapter(axios);

describe('Satfocus Voice Integration Tests', () => {
    
    beforeAll(() => {
        process.env.RETELL_API_KEY = 'test_key_123';
        process.env.RETELL_AGENT_ID = 'agent_test_456';
        jest.spyOn(console, 'log').mockImplementation(() => {});
        jest.spyOn(console, 'error').mockImplementation(() => {});
    });

    beforeEach(() => {
        mock.reset();
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    test('✅ SUCCESS: Should return valid TwiML Stream when Retell responds', async () => {
        const fakeCallId = 'call_satfocus_888';
        mock.onPost('https://api.retellai.com/v2/register-phone-call').reply(200, {
            call_id: fakeCallId
        });

        const response = await request(app)
            .post('/api/retell-webhook')
            .send({ From: '+12223334444', To: '+15556667777' });

        expect(response.status).toBe(200);
        expect(response.text).toContain(`audio-websocket/${fakeCallId}`);
    });

    test('❌ FAILOVER: Should handle Retell API failure gracefully', async () => {
        // Force a 500 error for the mock
        mock.onPost('https://api.retellai.com/v2/register-phone-call').reply(500);

        const response = await request(app)
            .post('/api/retell-webhook')
            .send({ From: '+12223334444' });

        expect(response.status).toBe(200);
        // We check for the TwiML tags instead of the exact message to avoid typo-fails
        expect(response.text).toContain('<Say');
        expect(response.text).toContain('<Hangup');
    });

    test('🏥 STATUS: Should return 200 OK for health check', async () => {
        const response = await request(app).get('/status');
        expect(response.status).toBe(200);
    });
});