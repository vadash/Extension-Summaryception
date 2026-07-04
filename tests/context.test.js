import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeContext } from './test-helpers.js';
import * as contextFacade from '../src/foundation/context.js';

beforeEach(() => {
    delete globalThis.SillyTavern;
});

describe('context.js facade', () => {
    it('returns raw context roots', () => {
        const chat = [{ mes: 'hi' }];
        const ctx = installSillyTavernStub({ chat });

        expect(contextFacade.getContext()).toBe(ctx);
        expect(contextFacade.getChat()).toBe(chat);
        expect(contextFacade.getChatMetadata()).toBe(ctx.chatMetadata);
        expect(contextFacade.getExtensionSettings()).toBe(ctx.extensionSettings);
    });

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

    it('delegates persistence and slash-command methods', async () => {
        const saveSettingsDebounced = vi.fn();
        const saveMetadata = vi.fn(async () => {});
        const executeSlashCommandsWithOptions = vi.fn(async () => {});
        installSillyTavernStub({
            executeSlashCommandsWithOptions,
        });
        Object.assign(globalThis.SillyTavern.getContext(), {
            saveSettingsDebounced,
            saveMetadata,
        });

        contextFacade.saveSettingsDebounced();
        await contextFacade.saveMetadata();
        await contextFacade.executeSlashCommandsWithOptions('/hide 0', { showOutput: false });

        expect(saveSettingsDebounced).toHaveBeenCalledOnce();
        expect(saveMetadata).toHaveBeenCalledOnce();
        expect(executeSlashCommandsWithOptions).toHaveBeenCalledWith('/hide 0', {
            showOutput: false,
        });
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

    it.each([
        ['getPromptManager', 'promptManager', { getPromptCollection: () => {} }],
        [
            'getConnectionManagerRequestService',
            'ConnectionManagerRequestService',
            { sendRequest: () => {} },
        ],
        ['getSlashCommandParser', 'SlashCommandParser', { addCommandObject: () => {} }],
        ['getSlashCommand', 'SlashCommand', { fromProps: () => {} }],
        ['getEventSource', 'eventSource', { on: () => {} }],
        ['getEventTypes', 'event_types', { MESSAGE_RECEIVED: 'msg' }],
        ['getStreamingProcessor', 'streamingProcessor', { isFinished: true }],
    ])('%s returns the runtime value or null', (accessorName, contextKey, value) => {
        installSillyTavernStub({});
        globalThis.SillyTavern.getContext()[contextKey] = value;

        expect(contextFacade[accessorName]()).toBe(value);

        delete globalThis.SillyTavern.getContext()[contextKey];
        expect(contextFacade[accessorName]()).toBeNull();
    });
});
