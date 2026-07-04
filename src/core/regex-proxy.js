/**
 * Lazy loader for SillyTavern's regex engine.
 * Uses dynamic import so the extension still loads if ST reorganizes the module.
 */
import { LOG_PREFIX } from '../foundation/constants.js';

/**
 * @typedef {object} RegexModule
 * @property {(rawString: string, placement: number, options?: object) => string} getRegexedString - ST's regex transformation function
 * @property {{ USER_INPUT: number, AI_OUTPUT: number }} regex_placement - ST's placement enum for message sources
 */

/** @type {RegexModule | null} */
let _regexModule = null;
let _loadAttempted = false;

const REGEX_ENGINE_CACHE_KEY = 'summaryception_regex_engine_path';

const REGEX_ENGINE_PATHS = [
    '../../../../regex/engine.js',
    '../../../regex/engine.js',
    '/scripts/extensions/regex/engine.js',
];

async function loadRegexModule() {
    const cachedPath = getCachedRegexEnginePath();
    if (cachedPath) {
        const cachedModule = await tryImportRegexModule(cachedPath);
        if (cachedModule) {
            return cachedModule;
        }
        clearCachedRegexEnginePath();
    }

    const failures = [];

    for (const enginePath of REGEX_ENGINE_PATHS) {
        const mod = await tryImportRegexModule(enginePath, failures);
        if (mod) {
            cacheRegexEnginePath(enginePath);
            return mod;
        }
    }

    console.warn(LOG_PREFIX, 'Regex engine unavailable, using raw text.', failures.join(' | '));
    return null;
}

/**
 * Import one candidate regex engine module.
 * @param {string} enginePath
 * @param {string[] | null} [failures]
 * @returns {Promise<RegexModule | null>}
 */
async function tryImportRegexModule(enginePath, failures = null) {
    try {
        return /** @type {RegexModule} */ (await import(/* @vite-ignore */ enginePath));
    } catch (e) {
        failures?.push(`${enginePath}: ${e?.message || e}`);
        return null;
    }
}

function getCachedRegexEnginePath() {
    const storage = getLocalStorage();
    if (!storage) {
        return null;
    }

    let cachedPath = null;
    try {
        cachedPath = storage.getItem(REGEX_ENGINE_CACHE_KEY);
    } catch (_e) {
        return null;
    }

    if (!cachedPath) {
        return null;
    }
    if (!REGEX_ENGINE_PATHS.includes(cachedPath)) {
        removeCachedRegexEnginePath(storage);
        return null;
    }
    return cachedPath;
}

function cacheRegexEnginePath(enginePath) {
    const storage = getLocalStorage();
    if (!storage) {
        return;
    }

    try {
        storage.setItem(REGEX_ENGINE_CACHE_KEY, enginePath);
    } catch (_e) {
        // Ignore unavailable storage in hardened browser modes.
    }
}

function clearCachedRegexEnginePath() {
    const storage = getLocalStorage();
    if (!storage) {
        return;
    }

    removeCachedRegexEnginePath(storage);
}

function removeCachedRegexEnginePath(storage) {
    try {
        storage.removeItem(REGEX_ENGINE_CACHE_KEY);
    } catch (_e) {
        // Ignore unavailable storage in hardened browser modes.
    }
}

function getLocalStorage() {
    try {
        return globalThis.localStorage || null;
    } catch (_e) {
        return null;
    }
}

/**
 * Apply SillyTavern's regex scripts to a message string.
 * Falls back to the raw string if the regex engine is unavailable.
 * @param {string} mes - Raw message text
 * @param {boolean} isUser - True for user messages (USER_INPUT), false for assistant (AI_OUTPUT)
 * @param {number | undefined} depth - Prompt-context depth for ST regex min/max depth filters
 * @returns {Promise<string>} Regex-transformed text, or raw text on failure
 */
export async function applyRegexToMessage(mes, isUser, depth) {
    if (!mes || typeof mes !== 'string') {
        return mes;
    }

    if (!_regexModule && !_loadAttempted) {
        _loadAttempted = true;
        _regexModule = await loadRegexModule();
    }

    if (!_regexModule) {
        return mes;
    }

    try {
        const placement = isUser
            ? _regexModule.regex_placement.USER_INPUT
            : _regexModule.regex_placement.AI_OUTPUT;
        return _regexModule.getRegexedString(mes, placement, {
            isPrompt: true,
            depth,
        });
    } catch (e) {
        console.warn(LOG_PREFIX, 'Regex transformation failed, using raw text.', e?.message || e);
        return mes;
    }
}
