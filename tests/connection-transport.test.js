import { describe, expect, it } from 'vitest';
import { tryExtractChatContent } from '../src/core/connection-transport.js';

describe('tryExtractChatContent', () => {
    it('extracts common chat response content wrappers', () => {
        expect(tryExtractChatContent({ content: 'top-level' })).toBe('top-level');
        expect(tryExtractChatContent({ message: { content: 'message' } })).toBe('message');
        expect(tryExtractChatContent({ choices: [{ message: { content: 'choice' } }] })).toBe(
            'choice',
        );
        expect(tryExtractChatContent({ choices: [{ delta: { content: 'delta' } }] })).toBe('delta');
    });

    it('returns null for unsupported shapes', () => {
        expect(tryExtractChatContent(null)).toBeNull();
        expect(tryExtractChatContent('raw text')).toBeNull();
        expect(tryExtractChatContent({ choices: [{ delta: { role: 'assistant' } }] })).toBeNull();
        expect(
            tryExtractChatContent({ data: { text: 'fallback belongs to profiles' } }),
        ).toBeNull();
    });
});
