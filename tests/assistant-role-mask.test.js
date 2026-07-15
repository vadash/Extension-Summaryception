import { describe, expect, it, vi } from 'vitest';
import { maskUserRoleAsAssistantInGenerateData } from '../src/core/assistant-role-mask.js';

const ENABLED = Object.freeze({
    enabled: true,
    maskUserRoleAsAssistant: true,
});

describe('assistant role mask', () => {
    it('defaults legacy enabled settings to a marker-first rewrite of every user block', () => {
        const imageContent = [{ type: 'image_url', image_url: { url: 'data:' } }];
        const generateData = {
            prompt: [
                { role: 'system', content: 'rules' },
                { role: 'user', content: 'hello' },
                { role: 'user', content: imageContent },
                { role: 'user', content: 'tool call', tool_calls: [] },
                { role: 'user', content: 'tool result', tool_call_id: 'call-1' },
                { role: 'assistant', content: 'reply' },
            ],
        };

        const rewritten = maskUserRoleAsAssistantInGenerateData(generateData, ENABLED);

        expect(rewritten).toBe(4);
        expect(generateData.prompt).toEqual([
            { role: 'user', content: '[user-role compatibility marker]' },
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'hello' },
            { role: 'assistant', content: imageContent },
            { role: 'assistant', content: 'tool call', tool_calls: [] },
            { role: 'assistant', content: 'tool result', tool_call_id: 'call-1' },
            { role: 'assistant', content: 'reply' },
        ]);
    });

    it('rewrites all user blocks without a marker in rewrite-all mode', () => {
        const prompt = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'second' },
        ];

        const rewritten = maskUserRoleAsAssistantInGenerateData(
            { prompt },
            { ...ENABLED, maskUserRoleMode: 'rewrite_all' },
        );

        expect(rewritten).toBe(2);
        expect(prompt.map((message) => message.role)).toEqual([
            'assistant',
            'assistant',
            'assistant',
        ]);
        expect(prompt).toHaveLength(3);
    });

    it('appends the synthetic marker after rewriting in marker-last mode', () => {
        const messages = [
            { role: 'system', content: 'rules' },
            { role: 'user', content: 'hello' },
        ];

        const rewritten = maskUserRoleAsAssistantInGenerateData(
            { messages },
            { ...ENABLED, maskUserRoleMode: 'marker_last' },
        );

        expect(rewritten).toBe(1);
        expect(messages).toEqual([
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'hello' },
            { role: 'user', content: '[user-role compatibility marker]' },
        ]);
    });

    it('preserves the final user block even when later non-user blocks follow it', () => {
        const prompt = [
            { role: 'user', content: 'first' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: [{ type: 'text', text: 'final user' }] },
            { role: 'tool', content: 'later tool result' },
            { role: 'assistant', content: 'later assistant' },
        ];

        const rewritten = maskUserRoleAsAssistantInGenerateData(
            { prompt },
            { ...ENABLED, maskUserRoleMode: 'keep_last_user' },
        );

        expect(rewritten).toBe(1);
        expect(prompt.map((message) => message.role)).toEqual([
            'assistant',
            'assistant',
            'user',
            'tool',
            'assistant',
        ]);
        expect(prompt).toHaveLength(5);
    });

    it('does not add a marker when no user block exists', () => {
        const prompt = [
            { role: 'system', content: 'rules' },
            { role: 'assistant', content: 'reply' },
            { role: 'tool', content: 'result' },
        ];

        expect(maskUserRoleAsAssistantInGenerateData({ prompt }, ENABLED)).toBe(0);
        expect(prompt).toHaveLength(3);
    });

    it('no-ops when disabled or the payload is not a defensive object array', () => {
        const disabledPayload = { prompt: [{ role: 'user', content: 'hello' }] };
        const textPayload = { prompt: 'User: hello' };
        const mixedPayload = { prompt: [{ role: 'user', content: 'hello' }, 'invalid'] };

        expect(
            maskUserRoleAsAssistantInGenerateData(disabledPayload, {
                enabled: true,
                maskUserRoleAsAssistant: false,
            }),
        ).toBe(0);
        expect(maskUserRoleAsAssistantInGenerateData(textPayload, ENABLED)).toBe(0);
        expect(maskUserRoleAsAssistantInGenerateData(mixedPayload, ENABLED)).toBe(0);
        expect(disabledPayload.prompt[0].role).toBe('user');
    });

    it('supports direct arrays, prompt arrays, and messages arrays', () => {
        const directPayload = [{ role: 'user', content: 'direct' }];
        const promptPayload = { prompt: [{ role: 'user', content: 'prompt' }] };
        const messagesPayload = { messages: [{ role: 'user', content: 'messages' }] };
        const settings = { ...ENABLED, maskUserRoleMode: 'rewrite_all' };

        expect(maskUserRoleAsAssistantInGenerateData(directPayload, settings)).toBe(1);
        expect(maskUserRoleAsAssistantInGenerateData(promptPayload, settings)).toBe(1);
        expect(maskUserRoleAsAssistantInGenerateData(messagesPayload, settings)).toBe(1);
        expect(directPayload[0].role).toBe('assistant');
        expect(promptPayload.prompt[0].role).toBe('assistant');
        expect(messagesPayload.messages[0].role).toBe('assistant');
    });

    it('normalizes invalid modes to marker-first behavior defensively', () => {
        const prompt = [{ role: 'user', content: 'hello' }];

        expect(
            maskUserRoleAsAssistantInGenerateData(
                { prompt },
                { ...ENABLED, maskUserRoleMode: 'invalid' },
            ),
        ).toBe(1);
        expect(prompt).toEqual([
            { role: 'user', content: '[user-role compatibility marker]' },
            { role: 'assistant', content: 'hello' },
        ]);
    });

    it('logs one collapsed debug line with changed, kept, and short previews', () => {
        const groupSpy = vi.spyOn(console, 'groupCollapsed').mockImplementation(() => {});
        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
        const endSpy = vi.spyOn(console, 'groupEnd').mockImplementation(() => {});
        const prompt = [
            { role: 'user', content: 'first message with enough text to exceed forty visible symbols' },
            { role: 'assistant', content: 'reply' },
            { role: 'user', content: 'final user message' },
        ];

        try {
            maskUserRoleAsAssistantInGenerateData(
                { prompt },
                {
                    ...ENABLED,
                    debugMode: true,
                    maskUserRoleMode: 'keep_last_user',
                },
            );

            expect(groupSpy).toHaveBeenCalledOnce();
            expect(groupSpy.mock.calls[0][0]).toContain('changed=1, kept=1');
            expect(groupSpy.mock.calls[0][0]).toContain('mode=keep_last_user');
            expect(logSpy).toHaveBeenCalledOnce();
            expect(logSpy.mock.calls[0][0]).toEqual([
                {
                    index: 0,
                    action: 'changed',
                    preview: 'first message with enough text to exceed…',
                },
                { index: 2, action: 'kept', preview: 'final user message' },
            ]);
            expect(endSpy).toHaveBeenCalledOnce();
        } finally {
            groupSpy.mockRestore();
            logSpy.mockRestore();
            endSpy.mockRestore();
        }
    });
});
