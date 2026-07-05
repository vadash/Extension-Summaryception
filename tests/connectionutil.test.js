import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    getConnectionDisplayName,
    providers,
    resolveFallbackSummarizerConnectionSettings,
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

    it('keeps lower explicit Layer 0 response caps', () => {
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

    it('applies the default Layer 0 target cap when response length is unset', () => {
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
            summarizerResponseLength: 200,
        });
    });

    it('passes the Layer 0 target cap to the default provider', async () => {
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
            responseLength: 200,
        });
    });

    it('applies the Layer 0 target cap to OpenAI max tokens', () => {
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
            openaiMaxTokens: 170,
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
            summarizerResponseLength: 200,
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
