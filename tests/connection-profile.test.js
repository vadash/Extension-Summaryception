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

    it('extracts top-level content responses', async () => {
        await expectProfileResponse({ content: 'content response' }, 'content response');
    });

    it('extracts message.content responses', async () => {
        await expectProfileResponse(
            { message: { content: 'message response' } },
            'message response',
        );
    });

    it('extracts choices[0].message.content responses', async () => {
        await expectProfileResponse(
            { choices: [{ message: { content: 'choice response' } }] },
            'choice response',
        );
    });

    it('falls back to the data field', async () => {
        await expectProfileResponse(
            { data: { text: 'data response' } },
            '{"text":"data response"}',
        );
    });

    it('throws a non-retryable error for unexpected response objects', async () => {
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
