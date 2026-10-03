/** Lazy loader for SillyTavern's regex engine. */
import { warn } from '../foundation/logger.js';

/**
 * @typedef {object} RegexModule
 * @property {(rawString: string, placement: number, options?: object) => string} getRegexedString - SillyTavern's regex transformation function
 * @property {{ USER_INPUT: number, AI_OUTPUT: number }} regex_placement - SillyTavern's placement enum for message sources
 */
const REGEX_ENGINE_URL = '/scripts/extensions/regex/engine.js';

/** @type {RegexModule | null} */
let _regexModule = null;
// One load attempt per session: a missing engine must not turn every message
// into a failed import.
let _loadAttempted = false;

async function loadRegexModule() {
    try {
        return /** @type {RegexModule} */ (await import(/* @vite-ignore */ REGEX_ENGINE_URL));
    } catch (error) {
        warn('Regex engine unavailable, using raw text.', error?.message || error);
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
        // isPrompt selects the host's prompt variant so the passage matches
        // what the model reads.
        return _regexModule.getRegexedString(mes, placement, {
            isPrompt: true,
            depth,
        });
    } catch (e) {
        warn('Regex transformation failed, using raw text.', e?.message || e);
        return mes;
    }
}
