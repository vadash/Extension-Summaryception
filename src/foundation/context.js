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
 * Estimate the current foreground ST prompt by running Generate in dry-run mode.
 * This is intentionally button-driven UI work because prompt assembly can be slow.
 * @param {{ timeoutMs?: number }} [options] - Optional timeout in milliseconds
 * @returns {Promise<number | null>} Token count, or null when ST cannot expose it
 */
export async function estimateMainPromptTokens(options = {}) {
    const payload = await captureMainPromptPayload(options);
    if (payload === null || payload === undefined) {
        return null;
    }
    return await countPromptPayloadTokens(payload);
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
 * Get SillyTavern's event types enum, or null if unavailable.
 * @returns {Record<string, string> | null}
 */
export function getEventTypes() {
    return getContextEventTypes(getContext());
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

async function captureMainPromptPayload({ timeoutMs = 15000 } = {}) {
    const ctx = getContext();
    const eventSource = ctx.eventSource;
    const eventName = getContextEventTypes(ctx)?.GENERATE_AFTER_DATA;
    if (typeof ctx.generate !== 'function' || !eventSource || !eventName) {
        return null;
    }

    let promptPayload = null;
    const handler = (generateData, dryRun) => {
        if (dryRun) {
            promptPayload = extractPromptPayload(generateData);
        }
    };
    if (!addRuntimeListener(eventSource, eventName, handler)) {
        return null;
    }

    const controller = createAbortController();
    const timeout = createDryRunTimeout(timeoutMs, () => controller?.abort());
    try {
        await Promise.race([
            ctx.generate.call(ctx, 'normal', controller ? { signal: controller.signal } : {}, true),
            timeout.promise,
        ]);
    } catch (_e) {
        return null;
    } finally {
        timeout.cleanup();
        removeRuntimeListener(eventSource, eventName, handler);
    }
    return timeout.didTimeout() ? null : promptPayload;
}

function getContextEventTypes(ctx) {
    return ctx.eventTypes || ctx.event_types || null;
}

function extractPromptPayload(generateData) {
    if (!generateData || typeof generateData !== 'object') {
        return null;
    }
    if (Object.hasOwn(generateData, 'prompt')) {
        return generateData.prompt;
    }
    if (Object.hasOwn(generateData, 'input')) {
        return generateData.input;
    }
    return null;
}

async function countPromptPayloadTokens(payload) {
    if (Array.isArray(payload)) {
        const endpointCount = await countChatPromptTokensViaEndpoint(payload);
        if (endpointCount !== null) {
            return endpointCount;
        }
    }
    return await countPromptStringTokens(stringifyPromptPayload(payload));
}

async function countChatPromptTokensViaEndpoint(messages) {
    if (typeof fetch !== 'function') {
        return null;
    }
    const model = getTokenizerModelQuery();
    try {
        const response = await fetch(`/api/tokenizers/openai/count${model}`, {
            method: 'POST',
            headers: getRequestHeaders(),
            body: JSON.stringify(messages),
        });
        if (response && typeof response.ok === 'boolean' && !response.ok) {
            return null;
        }
        const data = await response.json();
        return normalizeTokenCount(data?.token_count);
    } catch (_e) {
        return null;
    }
}

async function countPromptStringTokens(text) {
    const ctx = getContext();
    if (typeof ctx.getTokenCountAsync !== 'function') {
        return null;
    }
    try {
        const padding = Number(ctx.powerUserSettings?.token_padding);
        const count = await ctx.getTokenCountAsync(
            text,
            Number.isFinite(padding) ? padding : undefined,
        );
        return normalizeTokenCount(count);
    } catch (_e) {
        return null;
    }
}

function getTokenizerModelQuery() {
    try {
        const ctx = getContext();
        const model = typeof ctx.getTokenizerModel === 'function' ? ctx.getTokenizerModel() : '';
        return model ? `?model=${encodeURIComponent(String(model))}` : '';
    } catch (_e) {
        return '';
    }
}

function stringifyPromptPayload(payload) {
    if (typeof payload === 'string') {
        return payload;
    }
    if (Array.isArray(payload)) {
        return payload.map(stringifyPromptMessage).join('\n\n');
    }
    return safeJsonStringify(payload);
}

function stringifyPromptMessage(message) {
    if (!message || typeof message !== 'object') {
        return String(message ?? '');
    }
    const role = message.role ? `[${message.role}]` : '';
    const name = message.name ? `${message.name}: ` : '';
    const content = stringifyPromptContent(message.content);
    return [role, `${name}${content}`].filter(Boolean).join('\n');
}

function stringifyPromptContent(content) {
    if (typeof content === 'string') {
        return content;
    }
    if (Array.isArray(content)) {
        return content.map(stringifyPromptContent).join('\n');
    }
    return safeJsonStringify(content);
}

function safeJsonStringify(value) {
    try {
        return JSON.stringify(value ?? '') || '';
    } catch (_e) {
        return String(value ?? '');
    }
}

function normalizeTokenCount(count) {
    const number = Number(count);
    if (!Number.isFinite(number)) {
        return null;
    }
    return Math.max(0, Math.ceil(number));
}

function addRuntimeListener(eventSource, eventName, handler) {
    if (typeof eventSource.on === 'function') {
        eventSource.on(eventName, handler);
        return true;
    }
    if (typeof eventSource.addEventListener === 'function') {
        eventSource.addEventListener(eventName, handler);
        return true;
    }
    return false;
}

function removeRuntimeListener(eventSource, eventName, handler) {
    if (typeof eventSource.removeListener === 'function') {
        eventSource.removeListener(eventName, handler);
    } else if (typeof eventSource.removeEventListener === 'function') {
        eventSource.removeEventListener(eventName, handler);
    }
}

function createAbortController() {
    if (typeof AbortController !== 'function') {
        return null;
    }
    return new AbortController();
}

function createDryRunTimeout(timeoutMs, onTimeout) {
    let timedOut = false;
    const ms = Math.max(1000, Number(timeoutMs) || 15000);
    let timer = null;
    const promise = new Promise((resolve) => {
        timer = setTimeout(() => {
            timedOut = true;
            onTimeout();
            resolve(null);
        }, ms);
    });
    return {
        promise,
        cleanup: () => clearTimeout(timer),
        didTimeout: () => timedOut,
    };
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
