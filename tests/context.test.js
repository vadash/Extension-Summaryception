import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installSillyTavernStub, makeContext } from './test-helpers.js';

beforeEach(() => {
    vi.resetModules();
    delete globalThis.SillyTavern;
});

describe('context.js facade', () => {
    it('getContext returns the raw ST context', async () => {
        const ctx = installSillyTavernStub();
        const { getContext } = await import('../src/foundation/context.js');
        expect(getContext()).toBe(ctx);
    });

    it('getChat returns ctx.chat', async () => {
        const chat = [{ mes: 'hi' }];
        installSillyTavernStub({ chat });
        const { getChat } = await import('../src/foundation/context.js');
        expect(getChat()).toBe(chat);
    });

    it('getChatMetadata returns ctx.chatMetadata', async () => {
        const ctx = installSillyTavernStub();
        const { getChatMetadata } = await import('../src/foundation/context.js');
        expect(getChatMetadata()).toBe(ctx.chatMetadata);
    });

    it('getExtensionSettings returns ctx.extensionSettings', async () => {
        const ctx = installSillyTavernStub();
        const { getExtensionSettings } = await import('../src/foundation/context.js');
        expect(getExtensionSettings()).toBe(ctx.extensionSettings);
    });

    it('getName1 returns name1 when present', async () => {
        const ctx = makeContext({ chat: [], metadata: {}, settings: {} });
        ctx.name1 = 'Lyra';
        globalThis.SillyTavern = { getContext: () => ctx };
        const { getName1 } = await import('../src/foundation/context.js');
        expect(getName1()).toBe('Lyra');
    });

    it('getName1 falls back to User when name1 is absent', async () => {
        const ctx = makeContext({ chat: [], metadata: {}, settings: {} });
        delete ctx.name1;
        globalThis.SillyTavern = { getContext: () => ctx };
        const { getName1 } = await import('../src/foundation/context.js');
        expect(getName1()).toBe('User');
    });

    it('saveSettingsDebounced delegates to ctx', async () => {
        const saveSettingsDebounced = vi.fn();
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().saveSettingsDebounced = saveSettingsDebounced;
        const { saveSettingsDebounced: fn } = await import('../src/foundation/context.js');
        fn();
        expect(saveSettingsDebounced).toHaveBeenCalledOnce();
    });

    it('saveMetadata delegates to ctx', async () => {
        const saveMetadata = vi.fn(async () => {});
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().saveMetadata = saveMetadata;
        const { saveMetadata: fn } = await import('../src/foundation/context.js');
        await fn();
        expect(saveMetadata).toHaveBeenCalledOnce();
    });

    it('saveChat no-ops when ctx.saveChat is absent', async () => {
        const { saveChat } = await import('../src/foundation/context.js');
        await expect(saveChat()).resolves.toBeUndefined();
    });

    it('saveChat delegates when ctx.saveChat exists', async () => {
        const saveChat = vi.fn(async () => {});
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().saveChat = saveChat;
        const { saveChat: fn } = await import('../src/foundation/context.js');
        await fn();
        expect(saveChat).toHaveBeenCalledOnce();
    });

    it('executeSlashCommandsWithOptions delegates to ctx', async () => {
        const executeSlashCommandsWithOptions = vi.fn(async () => {});
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().executeSlashCommandsWithOptions =
            executeSlashCommandsWithOptions;
        const { executeSlashCommandsWithOptions: fn } =
            await import('../src/foundation/context.js');
        await fn('/hide 0', { showOutput: false });
        expect(executeSlashCommandsWithOptions).toHaveBeenCalledWith('/hide 0', {
            showOutput: false,
        });
    });

    it('setExtensionPrompt delegates to ctx with default options', async () => {
        const setExtensionPrompt = vi.fn();
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().setExtensionPrompt = setExtensionPrompt;
        const { setExtensionPrompt: fn } = await import('../src/foundation/context.js');
        fn('summaryception', 'text');
        expect(setExtensionPrompt).toHaveBeenCalledWith('summaryception', 'text', 0, 0, false, 0);
    });

    it('setExtensionPrompt passes through options', async () => {
        const setExtensionPrompt = vi.fn();
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().setExtensionPrompt = setExtensionPrompt;
        const { setExtensionPrompt: fn } = await import('../src/foundation/context.js');
        fn('summaryception', 'text', { position: 1, depth: 2, scan: true, role: 3 });
        expect(setExtensionPrompt).toHaveBeenCalledWith('summaryception', 'text', 1, 2, true, 3);
    });

    it('generateRaw delegates to ctx with this binding preserved', async () => {
        const generateRaw = vi.fn(async () => 'result');
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().generateRaw = generateRaw;
        const { generateRaw: fn } = await import('../src/foundation/context.js');
        const result = await fn({ prompt: 'hi' });
        expect(result).toBe('result');
        expect(generateRaw).toHaveBeenCalledWith({ prompt: 'hi' });
    });

    it('generateRaw throws when ctx.generateRaw is absent', async () => {
        installSillyTavernStub({});
        delete globalThis.SillyTavern.getContext().generateRaw;
        const { generateRaw: fn } = await import('../src/foundation/context.js');
        await expect(fn({})).rejects.toThrow('not available');
    });

    it('callTokenCountAsync delegates to ctx with this binding preserved', async () => {
        const getTokenCountAsync = vi.fn(async () => 42);
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().getTokenCountAsync = getTokenCountAsync;
        const { callTokenCountAsync: fn } = await import('../src/foundation/context.js');
        const result = await fn('hello');
        expect(result).toBe(42);
        expect(getTokenCountAsync).toHaveBeenCalledWith('hello');
    });

    it('callTokenCountAsync throws when ctx.getTokenCountAsync is absent', async () => {
        installSillyTavernStub({});
        delete globalThis.SillyTavern.getContext().getTokenCountAsync;
        const { callTokenCountAsync: fn } = await import('../src/foundation/context.js');
        await expect(fn('text')).rejects.toThrow('not available');
    });

    it('getRequestHeaders returns ctx.getRequestHeaders result', async () => {
        const headers = { 'X-CSRF': 'token' };
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext().getRequestHeaders = () => headers;
        const { getRequestHeaders } = await import('../src/foundation/context.js');
        expect(getRequestHeaders()).toBe(headers);
    });

    it('getRequestHeaders falls back when ctx.getRequestHeaders is absent', async () => {
        installSillyTavernStub({});
        delete globalThis.SillyTavern.getContext().getRequestHeaders;
        const { getRequestHeaders } = await import('../src/foundation/context.js');
        expect(getRequestHeaders()).toEqual({ 'Content-Type': 'application/json' });
    });

    it('getPromptManager returns ctx.promptManager or null', async () => {
        installSillyTavernStub({});
        const pm = { getPromptCollection: () => {} };
        globalThis.SillyTavern.getContext().promptManager = pm;
        const { getPromptManager } = await import('../src/foundation/context.js');
        expect(getPromptManager()).toBe(pm);
        delete globalThis.SillyTavern.getContext().promptManager;
        const { getPromptManager: fn2 } = await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });

    it('getConnectionManagerRequestService returns service or null', async () => {
        installSillyTavernStub({});
        const service = { sendRequest: () => {} };
        globalThis.SillyTavern.getContext().ConnectionManagerRequestService = service;
        const { getConnectionManagerRequestService: fn } =
            await import('../src/foundation/context.js');
        expect(fn()).toBe(service);
        delete globalThis.SillyTavern.getContext().ConnectionManagerRequestService;
        const { getConnectionManagerRequestService: fn2 } =
            await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });

    it('getSlashCommandParser returns parser or null', async () => {
        installSillyTavernStub({});
        const parser = { addCommandObject: () => {} };
        globalThis.SillyTavern.getContext().SlashCommandParser = parser;
        const { getSlashCommandParser: fn } = await import('../src/foundation/context.js');
        expect(fn()).toBe(parser);
        delete globalThis.SillyTavern.getContext().SlashCommandParser;
        const { getSlashCommandParser: fn2 } = await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });

    it('getSlashCommand returns helper class or null', async () => {
        installSillyTavernStub({});
        const cmd = { fromProps: () => {} };
        globalThis.SillyTavern.getContext().SlashCommand = cmd;
        const { getSlashCommand: fn } = await import('../src/foundation/context.js');
        expect(fn()).toBe(cmd);
        delete globalThis.SillyTavern.getContext().SlashCommand;
        const { getSlashCommand: fn2 } = await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });

    it('getEventSource returns eventSource or null', async () => {
        installSillyTavernStub({});
        const eventSource = { on: () => {} };
        globalThis.SillyTavern.getContext().eventSource = eventSource;
        const { getEventSource: fn } = await import('../src/foundation/context.js');
        expect(fn()).toBe(eventSource);
        delete globalThis.SillyTavern.getContext().eventSource;
        const { getEventSource: fn2 } = await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });

    it('getEventTypes returns event_types or null', async () => {
        installSillyTavernStub({});
        const event_types = { MESSAGE_RECEIVED: 'msg' };
        globalThis.SillyTavern.getContext().event_types = event_types;
        const { getEventTypes: fn } = await import('../src/foundation/context.js');
        expect(fn()).toBe(event_types);
        delete globalThis.SillyTavern.getContext().event_types;
        const { getEventTypes: fn2 } = await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });

    it('getStreamingProcessor returns streamingProcessor or null', async () => {
        installSillyTavernStub({});
        const streamingProcessor = { isFinished: true };
        globalThis.SillyTavern.getContext().streamingProcessor = streamingProcessor;
        const { getStreamingProcessor: fn } = await import('../src/foundation/context.js');
        expect(fn()).toBe(streamingProcessor);
        delete globalThis.SillyTavern.getContext().streamingProcessor;
        const { getStreamingProcessor: fn2 } = await import('../src/foundation/context.js');
        expect(fn2()).toBeNull();
    });
});
