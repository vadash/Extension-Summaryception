/**
 * Thin facade over SillyTavern.getContext().
 *
 * Centralizes every read/write against the SillyTavern runtime so that
 * API renames (chatMetadata, setExtensionPrompt, etc.) only need to be
 * updated in one place. Each accessor is defensive: missing fields
 * return null or a safe fallback instead of throwing.
 */

/**
 * Get the raw SillyTavern context object.
 * @returns {SillyTavernContext} The current SillyTavern context
 */
export function getContext() {
    return SillyTavern.getContext();
}

/**
 * Get the active chat array.
 * @returns {ChatMessage[]}
 */
export function getChat() {
    return getContext().chat;
}

/**
 * Get the chat metadata object (per-chat extension storage root).
 * @returns {Record<string, SummaryceptionStore>}
 */
export function getChatMetadata() {
    return getContext().chatMetadata;
}

/**
 * Get the extension settings object (cross-chat settings root).
 * @returns {Record<string, ExtensionSettings>}
 */
export function getExtensionSettings() {
    return getContext().extensionSettings;
}

/**
 * Get the player's display name.
 * @returns {string}
 */
export function getName1() {
    return getContext().name1 || 'User';
}

/**
 * Persist extension settings.
 * @returns {void}
 */
export function saveSettingsDebounced() {
    getContext().saveSettingsDebounced();
}

/**
 * Persist chat metadata.
 * @returns {Promise<void>}
 */
export async function saveMetadata() {
    await getContext().saveMetadata();
}

/**
 * Persist the active chat. No-op when the runtime lacks saveChat.
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
 * Execute a slash command through SillyTavern's command parser.
 * @param {string} command - The slash command string
 * @param {Record<string, unknown>} [options] - Command options
 * @returns {Promise<void>}
 */
export async function executeSlashCommandsWithOptions(command, options = {}) {
    await getContext().executeSlashCommandsWithOptions(command, options);
}

/**
 * Set an extension prompt via SillyTavern's PromptManager bridge.
 * @param {string} name - Extension identifier
 * @param {string} text - Prompt text
 * @param {{ position?: number, depth?: number, scan?: boolean, role?: unknown }} [options] - Optional position/depth/scan/role
 * @returns {void}
 */
export function setExtensionPrompt(name, text, options = {}) {
    const { position = 0, depth = 0, scan = false, role = 0 } = options;
    getContext().setExtensionPrompt(name, text, position, depth, scan, role);
}

/**
 * Call SillyTavern's active generateRaw function, preserving `this` binding.
 * @param {GenerateRawOptions} options - Generate options
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
 * Call SillyTavern's active tokenizer, preserving `this` binding.
 * @param {string} text - Text to count
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
 * Get SillyTavern's PromptManager, or null if unavailable.
 * @returns {SillyTavernPromptManager | null}
 */
export function getPromptManager() {
    return getContext().promptManager || null;
}

/**
 * Get SillyTavern's ConnectionManagerRequestService, or null if unavailable.
 * @returns {ConnectionManagerRequestService | null}
 */
export function getConnectionManagerRequestService() {
    return getContext().ConnectionManagerRequestService || null;
}

/**
 * Get SillyTavern's SlashCommandParser, or null if unavailable.
 * @returns {SlashCommandParser | null}
 */
export function getSlashCommandParser() {
    return getContext().SlashCommandParser || null;
}

/**
 * Get SillyTavern's SlashCommand helper class, or null if unavailable.
 * @returns {SlashCommand | null}
 */
export function getSlashCommand() {
    return getContext().SlashCommand || null;
}

/**
 * Get SillyTavern's event source, or null if unavailable.
 * @returns {SillyTavernEventSource | null}
 */
export function getEventSource() {
    return getContext().eventSource || null;
}

/**
 * Get SillyTavern's event_types enum, or null if unavailable.
 * @returns {Record<string, string> | null}
 */
export function getEventTypes() {
    return getContext().event_types || null;
}

/**
 * Get SillyTavern's active streaming processor, or null if unavailable.
 * @returns {SillyTavernStreamingProcessor | null}
 */
export function getStreamingProcessor() {
    return getContext().streamingProcessor || null;
}

/**
 * Check whether SillyTavern's chat send control is currently showing stop mode.
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
 * Check common stop-mode markers on a jQuery-like button object.
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
 * Read a best-effort string value from a jQuery-like object.
 * @param {object} element - jQuery-like object
 * @param {string} method - Method name
 * @param {string} [arg] - Optional method argument
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
