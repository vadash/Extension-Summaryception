import { vi } from 'vitest';

/**
 * Shared test helpers for SillyTavern extension unit tests.
 * Provides a minimal stub of the SillyTavern.getContext() contract
 * so modules can be tested without the browser runtime.
 */

/** Build a stub chat message. */
export function makeMessage({
    isUser = false,
    isSystem = false,
    isHidden = false,
    mes = 'Hello, world.',
    name = 'Assistant',
    ghosted = false,
} = {}) {
    return {
        is_user: isUser,
        is_system: isSystem,
        is_hidden: isHidden,
        mes,
        name,
        extra: ghosted ? { sc_ghosted: true } : {},
    };
}

/** Build repeated chat messages. */
export function makeMessages(count, options = {}) {
    return Array.from({ length: count }, (_value, index) =>
        makeMessage(typeof options === 'function' ? options(index) : options),
    );
}

/** Build repeated long assistant messages for budget-window tests. */
export function makeLongMessages(count, length = 3000) {
    return makeMessages(count, { mes: 'x'.repeat(length) });
}

/** Build common summarization settings with overrides. */
export function makeSummarySettings(overrides = {}) {
    return {
        enabled: true,
        memoryMode: 'standard',
        customMemoryPosition: 'in_prompt',
        customMemoryRole: 'system',
        customMemoryDepth: 0,
        applyRegexScripts: false,
        minSummaryTurns: 2,
        maxSummaryTurns: 5,
        minSummaryBudget: 6000,
        verbatimTokenBudget: 16000,
        memoryTokenBudget: 10000,
        snippetsPerLayer: 30,
        snippetsPerPromotion: 3,
        ...overrides,
    };
}

/** Build a normalized Summaryception metadata store. */
export function makeSummaryStore(overrides = {}) {
    return {
        layers: [],
        summarizedUpTo: -1,
        ghostedIndices: [],
        ...overrides,
    };
}

/** Build a mock toastr global. */
export function makeToastrMock() {
    return {
        info: vi.fn(),
        success: vi.fn(),
        warning: vi.fn(),
        error: vi.fn(),
        clear: vi.fn(),
    };
}

/** Install minimal browser globals expected by entry/UI-adjacent modules. */
export function installBrowserRuntimeStub(opts = {}) {
    const toastr = makeToastrMock();
    const $ =
        opts.$ ||
        vi.fn(() => ({
            find: () => ({ text: vi.fn() }),
            length: 1,
        }));
    globalThis.toastr = toastr;
    globalThis.$ = $;
    return { toastr, $ };
}

/** Build a stub SillyTavern context with configurable chat and metadata. */
export function makeContext({
    chat = [],
    metadata = {},
    settings = {},
    executeSlashCommandsWithOptions = async () => {},
    saveChat,
    setExtensionPrompt = () => {},
    getTokenCountAsync,
} = {}) {
    const ctx = {
        chat,
        chatMetadata: metadata,
        extensionSettings: { summaryception: settings },
        name1: 'Player1',
        saveSettingsDebounced: () => {},
        saveMetadata: async () => {},
        executeSlashCommandsWithOptions,
        setExtensionPrompt,
    };
    if (saveChat) {
        ctx.saveChat = saveChat;
    }
    if (getTokenCountAsync) {
        ctx.getTokenCountAsync = getTokenCountAsync;
    }
    return ctx;
}

/** Install a fresh SillyTavern stub and return its context. */
export function installSillyTavernStub(opts = {}) {
    const ctx = makeContext(opts);
    globalThis.SillyTavern = {
        getContext: () => ctx,
    };
    return ctx;
}

/** Install a Summaryception-ready SillyTavern context. */
export function installSummaryContext(opts = {}) {
    const { chat = [], metadata, settings = {}, getTokenCountAsync, ...rest } = opts;
    return installSillyTavernStub({
        chat,
        metadata: metadata || { summaryception: makeSummaryStore() },
        settings: makeSummarySettings(settings),
        getTokenCountAsync: getTokenCountAsync || (async (text) => String(text || '').length),
        ...rest,
    });
}

/** Build a deferred promise for async coalescing tests. */
export function deferred() {
    /** @type {(value?: unknown) => void} */
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
}

/** Count whitespace-delimited tokens in a test-friendly way. */
export function countTokens(text) {
    const trimmed = String(text || '').trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
}
