import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendViaProfile } from '../src/core/connection-profile.js';

beforeEach(() => {
    delete globalThis.SillyTavern;
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
    vi.restoreAllMocks();
});

function installProfileService(raw) {
    const sendRequest = vi.fn(async () => raw);
    globalThis.SillyTavern = {
        getContext: () => ({
            ConnectionManagerRequestService: {
                sendRequest,
            },
        }),
    };
    return sendRequest;
}

async function expectProfileResponse(raw, expected) {
    installProfileService(raw);

    await expect(sendViaProfile('profile-1', 'system prompt', 'user prompt')).resolves.toBe(
        expected,
    );
}

describe('sendViaProfile', () => {
    it('returns string responses from sendRequest', async () => {
        const sendRequest = installProfileService('string response');

        await expect(sendViaProfile('profile-1', 'system prompt', 'user prompt')).resolves.toBe(
            'string response',
        );

        expect(sendRequest).toHaveBeenCalledWith(
            'profile-1',
            [
                { role: 'system', content: 'system prompt' },
                { role: 'user', content: 'user prompt' },
            ],
            undefined,
            { includeInstruct: false },
        );
    });

    it('passes abort signals to Connection Manager requests', async () => {
        const controller = new AbortController();
        const sendRequest = installProfileService('string response');

        await expect(
            sendViaProfile('profile-1', 'system prompt', 'user prompt', 0, controller.signal),
        ).resolves.toBe('string response');

        expect(sendRequest).toHaveBeenCalledWith(
            'profile-1',
            [
                { role: 'system', content: 'system prompt' },
                { role: 'user', content: 'user prompt' },
            ],
            undefined,
            { includeInstruct: false, signal: controller.signal },
        );
    });

    it('parses supported object responses and rejects unexpected objects', async () => {
        const cases = [
            [{ content: 'content response' }, 'content response'],
            [{ message: { content: 'message response' } }, 'message response'],
            [{ choices: [{ message: { content: 'choice response' } }] }, 'choice response'],
            [{ data: { text: 'data response' } }, '{"text":"data response"}'],
        ];

        for (const [raw, expected] of cases) {
            await expectProfileResponse(raw, expected);
        }

        installProfileService({ unexpected: true });

        await expect(
            sendViaProfile('profile-1', 'system prompt', 'user prompt'),
        ).rejects.toMatchObject({
            name: 'ConnectionError',
            retryable: false,
            message: expect.stringContaining('unexpected type'),
        });
    });
});
