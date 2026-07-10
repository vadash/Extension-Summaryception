import { describe, expect, it } from 'vitest';
import { maskUserRoleAsAssistantInGenerateData } from '../src/core/assistant-role-mask.js';

const ENABLED = Object.freeze({
    enabled: true,
    maskUserRoleAsAssistant: true,
});

describe('assistant role mask', () => {
    it('rewrites text-only user prompt messages as assistant messages and adds a compatibility marker', () => {
        const generateData = {
            prompt: [
                { role: 'system', content: 'rules' },
                { role: 'user', content: 'hello' },
                { role: 'user', content: [{ type: 'text', text: 'second' }] },
                { role: 'assistant', content: 'reply' },
            ],
        };

        const rewritten = maskUserRoleAsAssistantInGenerateData(generateData, ENABLED);

        expect(rewritten).toBe(2);
        expect(generateData.prompt).toEqual([
            { role: 'user', content: '[user-role compatibility marker]' },
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'hello' },
            { role: 'assistant', content: [{ type: 'text', text: 'second' }] },
            { role: 'assistant', content: 'reply' },
        ]);
    });

    it('leaves multimodal and tool-adjacent user messages unchanged', () => {
        const generateData = {
            prompt: [
                { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] },
                { role: 'user', content: 'tool call', tool_calls: [] },
                { role: 'user', content: 'tool result', tool_call_id: 'call-1' },
            ],
        };

        const rewritten = maskUserRoleAsAssistantInGenerateData(generateData, ENABLED);

        expect(rewritten).toBe(0);
        expect(generateData.prompt.every((message) => message.role === 'user')).toBe(true);
    });

    it('no-ops when disabled or the payload is not a chat array', () => {
        const disabledPayload = { prompt: [{ role: 'user', content: 'hello' }] };
        const textPayload = { prompt: 'User: hello' };

        expect(
            maskUserRoleAsAssistantInGenerateData(disabledPayload, {
                enabled: true,
                maskUserRoleAsAssistant: false,
            }),
        ).toBe(0);
        expect(maskUserRoleAsAssistantInGenerateData(textPayload, ENABLED)).toBe(0);
        expect(disabledPayload.prompt[0].role).toBe('user');
    });

    it('supports direct message-array payloads and messages properties defensively', () => {
        const directPayload = [{ role: 'user', content: 'direct' }];
        const messagesPayload = { messages: [{ role: 'user', content: 'messages' }] };

        expect(maskUserRoleAsAssistantInGenerateData(directPayload, ENABLED)).toBe(1);
        expect(maskUserRoleAsAssistantInGenerateData(messagesPayload, ENABLED)).toBe(1);
        expect(directPayload).toEqual([
            { role: 'user', content: '[user-role compatibility marker]' },
            { role: 'assistant', content: 'direct' },
        ]);
        expect(messagesPayload.messages).toEqual([
            { role: 'user', content: '[user-role compatibility marker]' },
            { role: 'assistant', content: 'messages' },
        ]);
    });

    it('does not add a marker when a non-maskable user message remains', () => {
        const generateData = {
            prompt: [
                { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] },
                { role: 'user', content: 'text-only' },
            ],
        };

        const rewritten = maskUserRoleAsAssistantInGenerateData(generateData, ENABLED);

        expect(rewritten).toBe(1);
        expect(generateData.prompt).toEqual([
            { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:' } }] },
            { role: 'assistant', content: 'text-only' },
        ]);
    });

    it('adds a marker for direct array payloads with only user messages', () => {
        const directPayload = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'second' },
        ];

        const rewritten = maskUserRoleAsAssistantInGenerateData(directPayload, ENABLED);

        expect(rewritten).toBe(2);
        expect(directPayload).toEqual([
            { role: 'user', content: '[user-role compatibility marker]' },
            { role: 'assistant', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'assistant', content: 'second' },
        ]);
    });
});
