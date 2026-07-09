import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeContext } from './test-helpers.js';

vi.unmock('../src/foundation/context.js');

let contextFacade;

beforeAll(async () => {
    contextFacade = await import('../src/foundation/context.js');
});

beforeEach(() => {
    delete globalThis.SillyTavern;
    delete globalThis.$;
});

describe('context.js facade', () => {
    it('getName1 returns name1 or the User fallback', () => {
        const named = makeContext({ chat: [], metadata: {}, settings: {} });
        named.name1 = 'Lyra';
        globalThis.SillyTavern = { getContext: () => named };
        expect(contextFacade.getName1()).toBe('Lyra');

        const unnamed = makeContext({ chat: [], metadata: {}, settings: {} });
        delete unnamed.name1;
        globalThis.SillyTavern = { getContext: () => unnamed };
        expect(contextFacade.getName1()).toBe('User');
    });

    it('saveChat no-ops when absent and delegates when present', async () => {
        await expect(contextFacade.saveChat()).resolves.toBeUndefined();

        const saveChat = vi.fn(async () => {});
        installSillyTavernStub({ saveChat });
        await contextFacade.saveChat();

        expect(saveChat).toHaveBeenCalledOnce();
    });

    it('setExtensionPrompt delegates defaults and options', () => {
        const setExtensionPrompt = vi.fn();
        installSillyTavernStub({ setExtensionPrompt });

        contextFacade.setExtensionPrompt('summaryception', 'text');
        contextFacade.setExtensionPrompt('summaryception', 'text', {
            position: 1,
            depth: 2,
            scan: true,
            role: 3,
        });

        expect(setExtensionPrompt).toHaveBeenNthCalledWith(
            1,
            'summaryception',
            'text',
            0,
            0,
            false,
            0,
        );
        expect(setExtensionPrompt).toHaveBeenNthCalledWith(
            2,
            'summaryception',
            'text',
            1,
            2,
            true,
            3,
        );
    });

    it('registers and unregisters macros through the legacy context bridge when registry import is unavailable', async () => {
        const registerMacro = vi.fn();
        const unregisterMacro = vi.fn();
        installSillyTavernStub({ registerMacro, unregisterMacro });

        const handler = () => 'macro text';

        await expect(
            contextFacade.registerMacro('summaryception_memory', handler, 'desc'),
        ).resolves.toBe(true);
        expect(registerMacro).toHaveBeenCalledWith(
            'summaryception_memory',
            expect.any(Function),
            'desc',
        );
        expect(registerMacro.mock.calls[0][1]()).toBe('macro text');

        await expect(contextFacade.unregisterMacro('summaryception_memory')).resolves.toBe(true);
        expect(unregisterMacro).toHaveBeenCalledWith('summaryception_memory');
    });

    it('generateRaw delegates or throws when unavailable', async () => {
        const generateRaw = vi.fn(async () => 'result');
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().generateRaw = generateRaw;

        await expect(contextFacade.generateRaw({ prompt: 'hi' })).resolves.toBe('result');
        expect(generateRaw).toHaveBeenCalledWith({ prompt: 'hi' });

        delete globalThis.SillyTavern.getContext().generateRaw;
        await expect(contextFacade.generateRaw({})).rejects.toThrow('not available');
    });

    it('callTokenCountAsync delegates or throws when unavailable', async () => {
        const getTokenCountAsync = vi.fn(async () => 42);
        installSillyTavernStub({ getTokenCountAsync });

        await expect(contextFacade.callTokenCountAsync('hello')).resolves.toBe(42);
        expect(getTokenCountAsync).toHaveBeenCalledWith('hello');

        delete globalThis.SillyTavern.getContext().getTokenCountAsync;
        await expect(contextFacade.callTokenCountAsync('text')).rejects.toThrow('not available');
    });

    it('getRequestHeaders returns runtime headers or a JSON fallback', () => {
        const headers = { 'X-CSRF': 'token' };
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().getRequestHeaders = () => headers;

        expect(contextFacade.getRequestHeaders()).toBe(headers);

        delete globalThis.SillyTavern.getContext().getRequestHeaders;
        expect(contextFacade.getRequestHeaders()).toEqual({ 'Content-Type': 'application/json' });
    });

    it('estimateMainPromptTokens captures and counts a dry-run text prompt', async () => {
        const eventSource = makeEventSource();
        const getTokenCountAsync = vi.fn(async (text, padding) => String(text).length + padding);
        const generate = vi.fn(async (_type, _options, dryRun) => {
            await eventSource.emit('generate_after_data', { prompt: 'hello world' }, dryRun);
        });
        installSillyTavernStub({
            eventSource,
            eventTypes: { GENERATE_AFTER_DATA: 'generate_after_data' },
            generate,
            getTokenCountAsync,
            powerUserSettings: { token_padding: 2 },
        });

        await expect(contextFacade.estimateMainPromptTokens()).resolves.toBe(13);
        expect(generate).toHaveBeenCalledWith('normal', expect.any(Object), true);
        expect(getTokenCountAsync).toHaveBeenCalledWith('hello world', 2);
    });

    it('estimateMainPromptTokens counts chat prompts with ST tokenizer endpoint', async () => {
        const eventSource = makeEventSource();
        const messages = [{ role: 'system', content: 'prompt' }];
        const generate = vi.fn(async (_type, _options, dryRun) => {
            await eventSource.emit('generate_after_data', { prompt: messages }, dryRun);
        });
        const previousFetch = globalThis.fetch;
        globalThis.fetch = vi.fn(async () => ({
            ok: true,
            json: async () => ({ token_count: 77 }),
        }));
        installSillyTavernStub({
            eventSource,
            eventTypes: { GENERATE_AFTER_DATA: 'generate_after_data' },
            generate,
            getRequestHeaders: () => ({ 'Content-Type': 'application/json', 'X-CSRF': 'token' }),
            getTokenizerModel: () => 'gpt-4o',
        });

        try {
            await expect(contextFacade.estimateMainPromptTokens()).resolves.toBe(77);
            expect(globalThis.fetch).toHaveBeenCalledWith(
                '/api/tokenizers/openai/count?model=gpt-4o',
                expect.objectContaining({
                    method: 'POST',
                    body: JSON.stringify(messages),
                }),
            );
        } finally {
            globalThis.fetch = previousFetch;
        }
    });

    it('estimateMainPromptTokens returns null when dry-run hooks are unavailable', async () => {
        installSillyTavernStub({});

        await expect(contextFacade.estimateMainPromptTokens()).resolves.toBeNull();
    });

    it('detects send button stop mode defensively', () => {
        globalThis.$ = vi.fn((selector) => {
            if (selector === '#mes_stop') {
                return { length: 1, css: () => 'none' };
            }
            if (selector === '#send_but') {
                return {
                    length: 1,
                    attr: (name) => (name === 'title' ? 'Stop generating' : ''),
                    text: () => '',
                    find: () => ({ length: 0 }),
                };
            }
            return { length: 0 };
        });

        expect(contextFacade.isSendButtonInStopMode()).toBe(true);

        globalThis.$ = vi.fn(() => {
            throw new Error('missing DOM');
        });

        expect(contextFacade.isSendButtonInStopMode()).toBe(false);
    });
});

function makeEventSource() {
    const listeners = new Map();
    return {
        on(eventName, handler) {
            const eventListeners = listeners.get(eventName) || [];
            eventListeners.push(handler);
            listeners.set(eventName, eventListeners);
        },
        removeListener(eventName, handler) {
            const eventListeners = listeners.get(eventName) || [];
            listeners.set(
                eventName,
                eventListeners.filter((listener) => listener !== handler),
            );
        },
        async emit(eventName, ...args) {
            for (const listener of listeners.get(eventName) || []) {
                await listener(...args);
            }
        },
    };
}
