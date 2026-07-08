import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getConnectionDisplayName,
    providers,
    resolveFallbackSummarizerConnectionSettings,
    resolvePrimarySummarizerConnectionSettings,
    resolveSummarizerConnectionSettings,
    sendSummarizerRequest,
    testSummarizerConnection,
} from '../src/core/connectionutil.js';

beforeEach(() => {
    delete globalThis.SillyTavern;
    vi.clearAllMocks();
});

function installGenerateRaw() {
    const generateRaw = vi.fn(async () => 'summary text');
    globalThis.SillyTavern = {
        getContext: () => ({ generateRaw }),
    };
    return generateRaw;
}

describe('connection providers registry', () => {
    it('registers every configured provider with the adapter contract', () => {
        expect(Object.keys(providers).sort()).toEqual(['default', 'ollama', 'openai', 'profile']);

        for (const provider of Object.values(providers)) {
            expect(provider.generate).toEqual(expect.any(Function));
            expect(provider.testConnection).toEqual(expect.any(Function));
            expect(provider.displayName).toEqual(expect.any(Function));
        }
    });

    it('routes unknown sources through the default provider', async () => {
        const generateRaw = installGenerateRaw();

        const result = await sendSummarizerRequest(
            {
                connectionSource: 'future-provider',
                summarizerResponseLength: 64,
            },
            'system prompt',
            'user prompt',
        );

        expect(result).toBe('summary text');
        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
            responseLength: 64,
        });
    });

    it('keeps promotion calls on the Layer 0 connection when merge source inherits', async () => {
        const generateRaw = installGenerateRaw();

        await sendSummarizerRequest(
            {
                connectionSource: 'default',
                summarizerResponseLength: 64,
                mergeConnectionSource: 'inherit',
                mergeSummarizerResponseLength: 128,
            },
            'system prompt',
            'user prompt',
            undefined,
            { kind: 'promotion' },
        );

        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
            responseLength: 64,
        });
    });

    it('routes promotion calls through the Layer 1+ override when configured', async () => {
        const generateRaw = installGenerateRaw();

        await sendSummarizerRequest(
            {
                connectionSource: 'openai',
                openaiModel: 'cheap-model',
                mergeConnectionSource: 'default',
                mergeSummarizerResponseLength: 32,
            },
            'system prompt',
            'user prompt',
            undefined,
            { kind: 'promotion' },
        );

        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
            responseLength: 32,
        });
    });

    it('does not inject a default promotion cap when response length is unset', async () => {
        const generateRaw = installGenerateRaw();

        await sendSummarizerRequest(
            {
                connectionSource: 'default',
                summarizerResponseLength: 0,
                mergeConnectionSource: 'inherit',
            },
            'system prompt',
            'user prompt',
            undefined,
            { kind: 'promotion', memoryTokensBefore: 1000 },
        );

        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
        });
    });

    it('maps merge model fields onto provider settings for promotion calls', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'openai',
                openaiUrl: 'https://example.test/v1',
                openaiKey: 'shared-key',
                openaiModel: 'cheap-model',
                openaiMaxTokens: 100,
                mergeConnectionSource: 'openai',
                mergeOpenaiModel: 'smart-model',
                mergeOpenaiMaxTokens: 300,
            },
            { kind: 'promotion' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            openaiUrl: 'https://example.test/v1',
            openaiKey: 'shared-key',
            openaiModel: 'smart-model',
            openaiMaxTokens: 300,
        });
    });

    it('does not inherit primary provider tunables when merge fields are unset', () => {
        const effective = resolvePrimarySummarizerConnectionSettings(
            {
                connectionSource: 'openai',
                summarizerResponseLength: 64,
                connectionProfileId: 'fast-profile',
                ollamaUrl: 'http://localhost:11434',
                ollamaModel: 'fast-ollama',
                openaiUrl: 'https://example.test/v1',
                openaiKey: 'shared-key',
                openaiModel: 'cheap-model',
                openaiMaxTokens: 100,
                mergeConnectionSource: 'openai',
            },
            { kind: 'promotion' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            summarizerResponseLength: 0,
            connectionProfileId: '',
            ollamaUrl: 'http://localhost:11434',
            ollamaModel: '',
            openaiUrl: 'https://example.test/v1',
            openaiKey: 'shared-key',
            openaiModel: '',
            openaiMaxTokens: 0,
        });
    });

    it('maps future prefixed route fields dynamically', () => {
        const effective = resolvePrimarySummarizerConnectionSettings(
            {
                connectionSource: 'default',
                mergeConnectionSource: 'openai',
                mergeAnthropicModel: 'claude-test',
                mergeClaudeThinkingBudget: 4096,
            },
            { kind: 'promotion' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            anthropicModel: 'claude-test',
            claudeThinkingBudget: 4096,
        });
    });

    it('does not inject a default OpenAI promotion cap when merge max tokens are unset', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'default',
                mergeConnectionSource: 'openai',
                mergeOpenaiModel: 'smart-model',
                mergeOpenaiMaxTokens: 0,
            },
            { kind: 'promotion', memoryTokensBefore: 944 },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            openaiModel: 'smart-model',
            openaiMaxTokens: 0,
        });
    });

    it('preserves explicit OpenAI merge max tokens for promotion calls', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'default',
                mergeConnectionSource: 'openai',
                mergeOpenaiModel: 'smart-model',
                mergeOpenaiMaxTokens: 3000,
            },
            { kind: 'promotion', memoryTokensBefore: 3000 },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            openaiModel: 'smart-model',
            openaiMaxTokens: 3000,
        });
    });

    it('falls back to the default provider for unknown merge sources', async () => {
        const generateRaw = installGenerateRaw();

        await sendSummarizerRequest(
            {
                connectionSource: 'openai',
                mergeConnectionSource: 'future-provider',
                mergeSummarizerResponseLength: 16,
            },
            'system prompt',
            'user prompt',
            undefined,
            { kind: 'promotion' },
        );

        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
            responseLength: 16,
        });
    });

    it('preserves explicit Layer 0 response caps', () => {
        const settings = {
            connectionSource: 'default',
            summarizerResponseLength: 64,
            mergeConnectionSource: 'profile',
            mergeConnectionProfileId: 'smart-profile',
        };

        expect(resolveSummarizerConnectionSettings(settings, { kind: 'layer0' })).toMatchObject({
            connectionSource: 'default',
            summarizerResponseLength: 64,
        });
    });

    it('leaves Layer 0 response length unset when configured as provider default', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'default',
                summarizerResponseLength: 0,
                layer0SummaryTokenTarget: 150,
            },
            { kind: 'layer0' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'default',
            summarizerResponseLength: 0,
        });
    });

    it('does not derive provider caps from large Layer 0 targets', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'default',
                summarizerResponseLength: 0,
                layer0SummaryTokenTarget: 500,
            },
            { kind: 'layer0' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'default',
            summarizerResponseLength: 0,
        });
    });

    it('omits responseLength for default-provider Layer 0 calls when set to 0', async () => {
        const generateRaw = installGenerateRaw();

        await sendSummarizerRequest(
            {
                connectionSource: 'default',
                summarizerResponseLength: 0,
                layer0SummaryTokenTarget: 150,
            },
            'system prompt',
            'user prompt',
            undefined,
            { kind: 'layer0' },
        );

        expect(generateRaw).toHaveBeenCalledWith({
            prompt: [{ role: 'user', content: 'user prompt' }],
            systemPrompt: 'system prompt',
            trimNames: false,
        });
    });

    it('leaves OpenAI max tokens unset for Layer 0 calls when configured as provider default', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'openai',
                openaiMaxTokens: 0,
                layer0SummaryTokenTarget: 120,
            },
            { kind: 'layer0' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            openaiMaxTokens: 0,
        });
    });

    it('preserves explicit OpenAI max tokens for Layer 0 calls', () => {
        const effective = resolveSummarizerConnectionSettings(
            {
                connectionSource: 'openai',
                openaiMaxTokens: 2048,
                layer0SummaryTokenTarget: 120,
            },
            { kind: 'layer0' },
        );

        expect(effective).toMatchObject({
            connectionSource: 'openai',
            openaiMaxTokens: 2048,
        });
    });

    it('resolves a distinct fallback route for Layer 0 calls', () => {
        const fallback = resolveFallbackSummarizerConnectionSettings(
            {
                connectionSource: 'profile',
                connectionProfileId: 'fast-profile',
                fallbackConnectionSource: 'profile',
                fallbackConnectionProfileId: 'backup-profile',
                fallbackSummarizerResponseLength: 512,
                layer0SummaryTokenTarget: 150,
            },
            { kind: 'layer0' },
        );

        expect(fallback).toMatchObject({
            connectionSource: 'profile',
            connectionProfileId: 'backup-profile',
            summarizerResponseLength: 512,
        });
    });

    it('resolves fallback after the promotion merge override', () => {
        const fallback = resolveFallbackSummarizerConnectionSettings(
            {
                connectionSource: 'profile',
                connectionProfileId: 'fast-profile',
                mergeConnectionSource: 'profile',
                mergeConnectionProfileId: 'smart-profile',
                fallbackConnectionSource: 'openai',
                openaiUrl: 'https://example.test/v1',
                openaiKey: 'shared-key',
                fallbackOpenaiModel: 'backup-model',
                fallbackOpenaiMaxTokens: 300,
                layer0SummaryTokenTarget: 150,
            },
            { kind: 'promotion' },
        );

        expect(fallback).toMatchObject({
            connectionSource: 'openai',
            openaiUrl: 'https://example.test/v1',
            openaiKey: 'shared-key',
            openaiModel: 'backup-model',
            openaiMaxTokens: 300,
        });
    });

    it('does not inject a default promotion cap into fallback routes', () => {
        const fallback = resolveFallbackSummarizerConnectionSettings(
            {
                connectionSource: 'profile',
                connectionProfileId: 'fast-profile',
                fallbackConnectionSource: 'default',
                fallbackSummarizerResponseLength: 0,
            },
            { kind: 'promotion', memoryTokensBefore: 944 },
        );

        expect(fallback).toMatchObject({
            connectionSource: 'default',
            summarizerResponseLength: 0,
        });
    });

    it('does not resolve fallback when it matches the primary route', () => {
        const fallback = resolveFallbackSummarizerConnectionSettings(
            {
                connectionSource: 'openai',
                openaiUrl: 'https://example.test/v1',
                openaiKey: 'shared-key',
                openaiModel: 'same-model',
                fallbackConnectionSource: 'openai',
                fallbackOpenaiModel: 'same-model',
            },
            { kind: 'layer0' },
        );

        expect(fallback).toBeNull();
    });

    it('tests connections through the resolved provider', async () => {
        installGenerateRaw();

        await expect(
            testSummarizerConnection({ connectionSource: 'default' }),
        ).resolves.toMatchObject({
            success: true,
            message: expect.stringContaining('Default connection'),
        });
    });

    it('uses provider display names with fallback to default', () => {
        expect(
            getConnectionDisplayName({
                connectionSource: 'openai',
                openaiModel: 'gpt-test',
            }),
        ).toBe('OpenAI: gpt-test');

        expect(getConnectionDisplayName({ connectionSource: 'unknown' })).toBe(
            'Default (Main API)',
        );
    });
});
