import { beforeEach, describe, expect, it, vi } from 'vitest';
import { sendViaDefault } from '../src/core/connection-default.js';

beforeEach(() => {
    vi.clearAllMocks();
});

describe('sendViaDefault', () => {
    it('passes an isolated raw user message to generateRaw without mutating prompt toggles', async () => {
        const generateRaw = vi.fn(async () => 'summary text');
        const promptOrder = [{ identifier: 'main', enabled: true }];

        globalThis.SillyTavern = {
            getContext: () => ({
                generateRaw,
                promptManager: {
                    getPromptOrderEntries: () => promptOrder,
                },
            }),
        };

        const result = await sendViaDefault('system prompt', 'user prompt', 128);

        expect(result).toBe('summary text');
        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
            responseLength: 128,
        });
        expect(promptOrder[0].enabled).toBe(true);
    });
});
