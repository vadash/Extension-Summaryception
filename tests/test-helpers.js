/**
 * Shared test helpers for SillyTavern extension unit tests.
 * Provides a minimal stub of the SillyTavern.getContext() contract
 * so modules can be tested without the browser runtime.
 */

/**
 * Build a stub chat message.
 * @param {Object} [opts]
 * @param {boolean} [opts.isUser]
 * @param {boolean} [opts.isSystem]
 * @param {boolean} [opts.isHidden]
 * @param {string} [opts.mes]
 * @param {string} [opts.name]
 * @param {boolean} [opts.ghosted]
 * @returns {Record<string, unknown>}
 */
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

/**
 * Build a stub SillyTavern context with configurable chat + metadata.
 * @param {Object} [opts]
 * @param {Array<Record<string, unknown>>} [opts.chat]
 * @param {Object} [opts.metadata]
 * * @param {Object} [opts.settings]
 * @returns {Record<string, unknown>}
 */
export function makeContext({ chat = [], metadata = {}, settings = {} } = {}) {
    return {
        chat,
        chatMetadata: metadata,
        extensionSettings: { summaryception: settings },
        name1: 'Player1',
        saveSettingsDebounced: () => {},
        saveMetadata: async () => {},
    };
}

/**
 * Install a fresh SillyTavern stub on globalThis before each test.
 * Returns the context object so tests can mutate chat/metadata.
 * @param {Object} [opts]
 */
export function installSillyTavernStub(opts = {}) {
    const ctx = makeContext(opts);
    globalThis.SillyTavern = {
        getContext: () => ctx,
    };
    return ctx;
}
