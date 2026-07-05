import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchOllamaModels,
    sendViaOllama,
    testOllamaConnection,
} from '../src/core/connection-ollama.js';

beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
    globalThis.SillyTavern = {
        getContext: () => ({
            getRequestHeaders: () => ({ 'X-CSRF-Token': 'test-token' }),
        }),
    };
});

function stubJsonResponse(data, status = 200) {
    /** @type {any} */ (globalThis.fetch).mockResolvedValue(
        new Response(JSON.stringify(data), {
            status,
            headers: { 'Content-Type': 'application/json' },
        }),
    );
}

describe('sendViaOllama', () => {
    it('sends chat requests through the proxy fallback transport', async () => {
        stubJsonResponse({ message: { content: 'summary text' } });

        const result = await sendViaOllama(
            'http://localhost:11434/',
            'llama3',
            'system prompt',
            'user prompt',
        );

        expect(result).toBe('summary text');
        expect(globalThis.fetch).toHaveBeenCalledWith('/proxy/http://localhost:11434/api/chat', {
            method: 'POST',
            headers: {
                'X-CSRF-Token': 'test-token',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: 'llama3',
                messages: [
                    { role: 'system', content: 'system prompt' },
                    { role: 'user', content: 'user prompt' },
                ],
                stream: false,
                options: { temperature: 0.3 },
            }),
        });
    });

    it('passes abort signals to proxied chat requests', async () => {
        const controller = new AbortController();
        stubJsonResponse({ message: { content: 'summary text' } });

        await sendViaOllama(
            'http://localhost:11434/',
            'llama3',
            'system prompt',
            'user prompt',
            controller.signal,
        );

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/proxy/http://localhost:11434/api/chat',
            expect.objectContaining({ signal: controller.signal }),
        );
    });

    it('passes max tokens as Ollama num_predict', async () => {
        stubJsonResponse({ message: { content: 'summary text' } });

        await sendViaOllama(
            'http://localhost:11434/',
            'llama3',
            'system prompt',
            'user prompt',
            180,
        );

        expect(globalThis.fetch).toHaveBeenCalledWith(
            '/proxy/http://localhost:11434/api/chat',
            expect.objectContaining({
                body: JSON.stringify({
                    model: 'llama3',
                    messages: [
                        { role: 'system', content: 'system prompt' },
                        { role: 'user', content: 'user prompt' },
                    ],
                    stream: false,
                    options: { temperature: 0.3, num_predict: 180 },
                }),
            }),
        );
    });
});

describe('fetchOllamaModels', () => {
    it('returns the models from /api/tags', async () => {
        const models = [{ name: 'llama3', size: 123, modified_at: 'today' }];
        stubJsonResponse({ models });

        await expect(fetchOllamaModels('http://localhost:11434')).resolves.toEqual(models);

        expect(globalThis.fetch).toHaveBeenCalledWith('/proxy/http://localhost:11434/api/tags', {
            method: 'GET',
            headers: {
                'X-CSRF-Token': 'test-token',
                'Content-Type': 'application/json',
            },
            body: undefined,
        });
    });
});

describe('testOllamaConnection', () => {
    it('succeeds when the selected model is available', async () => {
        stubJsonResponse({ models: [{ name: 'llama3' }] });

        await expect(
            testOllamaConnection('http://localhost:11434', 'llama3'),
        ).resolves.toMatchObject({
            success: true,
            message: expect.stringContaining('llama3'),
        });
    });

    it('fails when the selected model is absent', async () => {
        stubJsonResponse({ models: [{ name: 'mistral' }] });

        await expect(
            testOllamaConnection('http://localhost:11434', 'llama3'),
        ).resolves.toMatchObject({
            success: false,
            message: expect.stringContaining('not found'),
        });
    });
});
