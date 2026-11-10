import { describe, expect, it, vi } from 'vitest';

// The host facade itself is the subject here, so the shared setup's context
// mock is lifted and the real module reads the installed SillyTavern stub.
vi.unmock('../src/foundation/context.js');

import { canInlineImages, getName1 } from '../src/foundation/context.js';

describe('getName1', () => {
    it('returns the player name from the host context', () => {
        expect(getName1()).toBe('Player1');
    });

    it('falls back to "User" when the host exposes no name', () => {
        delete globalThis.SillyTavern.getContext().name1;
        expect(getName1()).toBe('User');
    });
});

describe('canInlineImages', () => {
    it('returns false without throwing when the host is absent', () => {
        const host = globalThis.SillyTavern;
        // @ts-expect-error test-only host removal
        delete globalThis.SillyTavern;
        try {
            expect(canInlineImages()).toBe(false);
        } finally {
            globalThis.SillyTavern = host;
        }
    });

    it('returns true for a custom chat-completion connection with media inlining', () => {
        globalThis.SillyTavern.getContext = () => ({
            mainApi: 'openai',
            chatCompletionSettings: { media_inlining: true, chat_completion_source: 'custom' },
        });

        expect(canInlineImages()).toBe(true);
    });

    it('returns false when media inlining is off or the API is not chat completion', () => {
        globalThis.SillyTavern.getContext = () => ({
            mainApi: 'openai',
            chatCompletionSettings: { media_inlining: false, chat_completion_source: 'custom' },
        });
        expect(canInlineImages()).toBe(false);

        globalThis.SillyTavern.getContext = () => ({
            mainApi: 'textgenerationwebui',
            chatCompletionSettings: { media_inlining: true, chat_completion_source: 'custom' },
        });
        expect(canInlineImages()).toBe(false);
    });
});
