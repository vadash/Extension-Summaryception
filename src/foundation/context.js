/**
 * Thin facade over SillyTavern.getContext().
 *
 * Centralizes every read/write against the SillyTavern runtime so API changes
 * need one update. Required APIs target the latest stable SillyTavern release;
 * optional integrations remain defensive.
 */

const SILLYTAVERN_MACRO_SYSTEM_PATH = '/scripts/macros/macro-system.js';
/**
 * @returns {SillyTavernContext}
 */
export function getContext() {
    return SillyTavern.getContext();
}

/**
 * @returns {ChatMessage[]}
 */
export function getChat() {
    return getContext().chat;
}

/**
 * Per-chat extension storage root.
 * @returns {Record<string, SummaryceptionStore>}
 */
export function getChatMetadata() {
    return getContext().chatMetadata;
}

/**
 * Active group chat id; empty in solo chats. Presence alone marks a group.
 * @returns {string | undefined}
 */
export function getGroupId() {
    return getContext().groupId ?? undefined;
}

/**
 * Cross-chat settings root.
 * @returns {Record<string, ExtensionSettings>}
 */
export function getExtensionSettings() {
    return getContext().extensionSettings;
}

/**
 * Player display name.
 * @returns {string}
 */
export function getName1() {
    return getContext().name1 || 'User';
}

/**
 * @returns {void}
 */
export function saveSettingsDebounced() {
    getContext().saveSettingsDebounced();
}

/**
 * @returns {Promise<void>}
 */
export async function saveMetadata() {
    await getContext().saveMetadata();
}

/**
 * No-op when the runtime lacks saveChat.
 * @returns {Promise<void>}
 */
export async function saveChat() {
    try {
        const fn = getContext().saveChat;
        if (typeof fn === 'function') {
            await fn();
        }
    } catch (_e) {
        /* runtime context unavailable */
    }
}

/**
 * No-op when the host lacks reloadCurrentChat.
 * @returns {Promise<void>}
 */
export async function reloadCurrentChat() {
    const reload = getContext().reloadCurrentChat;
    if (typeof reload === 'function') {
        await reload();
    }
}

/**
 * @param {number} index - Inserted chat index.
 * @returns {void}
 */
export function shiftRenderedMessageIds(index) {
    const shift = getContext().updateViewMessageIds;
    if (typeof shift === 'function') {
        shift(index);
    }
}

/**
 * @param {string} command
 * @param {Record<string, unknown>} [options]
 * @returns {Promise<void>}
 */
export async function executeSlashCommandsWithOptions(command, options = {}) {
    await getContext().executeSlashCommandsWithOptions(command, options);
}

/**
 * Set an extension prompt through SillyTavern's PromptManager bridge.
 * @param {string} name
 * @param {string} text
 * @param {{ position?: number, depth?: number, scan?: boolean, role?: unknown }} [options]
 * @returns {void}
 */
export function setExtensionPrompt(name, text, options = {}) {
    const { position = 0, depth = 0, scan = false, role = 0 } = options;
    getContext().setExtensionPrompt(name, text, position, depth, scan, role);
}

/**
 * @param {string} name - Macro identifier without braces.
 * @param {(context?: object) => string} handler
 * @param {string} [description] - Macro description for ST docs/autocomplete.
 * @returns {Promise<boolean>} Whether the registry accepted the macro.
 */
export async function registerMacro(name, handler, description = '') {
    const { macros, MacroCategory } = await import(SILLYTAVERN_MACRO_SYSTEM_PATH);
    return Boolean(
        macros.register(name, {
            category: MacroCategory.CHAT,
            description,
            handler: () => handler(),
        }),
    );
}

/**
 * Call SillyTavern's active generateRaw, preserving its `this` binding.
 * @param {GenerateRawOptions} options
 * @returns {Promise<string>}
 */
export async function generateRaw(options) {
    const ctx = getContext();
    if (typeof ctx.generateRaw !== 'function') {
        throw new Error('generateRaw is not available in the current context.');
    }
    return await ctx.generateRaw(options);
}

/**
 * Call SillyTavern's active tokenizer, preserving its `this` binding.
 * @param {string} text
 * @returns {Promise<number>}
 */
export async function callTokenCountAsync(text) {
    const ctx = getContext();
    if (typeof ctx.getTokenCountAsync !== 'function') {
        throw new Error('getTokenCountAsync is not available in the current context.');
    }
    return await ctx.getTokenCountAsync(text);
}

/**
 * Check both supported SillyTavern dry-run event signatures.
 * @param {unknown} eventData
 * @param {unknown} dryRunArg
 * @returns {boolean}
 */
export function isDryRunEvent(eventData, dryRunArg) {
    return (
        dryRunArg === true ||
        (eventData !== null &&
            typeof eventData === 'object' &&
            /** @type {{ dryRun?: unknown }} */ (eventData).dryRun === true)
    );
}

/**
 * Get request headers including ST's CSRF token if available.
 * @returns {Record<string, string>}
 */
export function getRequestHeaders() {
    try {
        const fn = getContext().getRequestHeaders;
        if (typeof fn === 'function') {
            return fn();
        }
    } catch (_e) {
        /* fallback */
    }
    return { 'Content-Type': 'application/json' };
}

/**
 * @returns {SillyTavernPromptManager | null}
 */
export function getPromptManager() {
    return getContext().promptManager || null;
}

/**
 * @returns {ConnectionManagerRequestService | null}
 */
export function getConnectionManagerRequestService() {
    return getContext().ConnectionManagerRequestService || null;
}

/**
 * @returns {SlashCommandParser | null}
 */
export function getSlashCommandParser() {
    return getContext().SlashCommandParser || null;
}

/**
 * @returns {SlashCommand | null}
 */
export function getSlashCommand() {
    return getContext().SlashCommand || null;
}

/**
 * @returns {SillyTavernEventSource | null}
 */
export function getEventSource() {
    return getContext().eventSource || null;
}

/**
 * @returns {Record<string, string> | null}
 */
export function getEventTypes() {
    return getContextEventTypes(getContext());
}

/**
 * @returns {SillyTavernStreamingProcessor | null}
 */
export function getStreamingProcessor() {
    return getContext().streamingProcessor || null;
}

/**
 * @returns {boolean}
 */
export function isSendButtonInStopMode() {
    try {
        const stopButton = $('#mes_stop');
        if (isJQueryElementVisible(stopButton)) {
            return true;
        }

        const sendButton = $('#send_but');
        if (hasStopButtonMarker(sendButton)) {
            return true;
        }

        const stopMarker = sendButton?.find?.(
            '.fa-stop, .fa-circle-stop, [title*="Stop"], [title*="stop"], [aria-label*="Stop"], [aria-label*="stop"]',
        );
        return Boolean(stopMarker?.length);
    } catch (_e) {
        return false;
    }
}

/**
 * Check visible state without assuming a full jQuery implementation in tests.
 * @param {object} element - jQuery-like object
 * @returns {boolean}
 */
function isJQueryElementVisible(element) {
    if (!element || element.length === 0) {
        return false;
    }
    if (typeof element.is === 'function') {
        return element.is(':visible');
    }
    if (typeof element.css === 'function') {
        return element.css('display') !== 'none';
    }
    return false;
}

/**
 * @param {object} element - jQuery-like object
 * @returns {boolean}
 */
function hasStopButtonMarker(element) {
    if (!element || element.length === 0) {
        return false;
    }

    const text = [
        readJQueryValue(element, 'attr', 'class'),
        readJQueryValue(element, 'attr', 'title'),
        readJQueryValue(element, 'attr', 'aria-label'),
        readJQueryValue(element, 'text'),
    ]
        .join(' ')
        .toLowerCase();
    return text.includes('fa-stop') || text.includes('fa-circle-stop') || text.includes('stop');
}

/**
 * SillyTavern versions expose eventTypes or event_types; read both.
 * @param {SillyTavernContext} ctx
 */
function getContextEventTypes(ctx) {
    return ctx.eventTypes || ctx.event_types || null;
}

/**
 * @param {object} element - jQuery-like object
 * @param {string} method
 * @param {string} [arg]
 * @returns {string}
 */
function readJQueryValue(element, method, arg) {
    try {
        const fn = element?.[method];
        if (typeof fn !== 'function') {
            return '';
        }
        const value = arg === undefined ? fn.call(element) : fn.call(element, arg);
        return typeof value === 'string' ? value : '';
    } catch (_e) {
        return '';
    }
}
