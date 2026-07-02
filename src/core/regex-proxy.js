/**
 * Lazy loader for SillyTavern's regex engine.
 * Uses dynamic import so the extension still loads if ST reorganizes the module.
 */

import { trace } from '../foundation/logger.js';

/**
 * @typedef {object} RegexModule
 * @property {(rawString: string, placement: number, options?: object) => string} getRegexedString - ST's regex transformation function
 * @property {{ USER_INPUT: number, AI_OUTPUT: number }} regex_placement - ST's placement enum for message sources
 */

/** @type {RegexModule | null} */
let _regexModule = null;
let _loadAttempted = false;

/**
 * Apply SillyTavern's regex scripts to a message string.
 * Falls back to the raw string if the regex engine is unavailable.
 * @param {string} mes - Raw message text
 * @param {boolean} isUser - True for user messages (USER_INPUT), false for assistant (AI_OUTPUT)
 * @returns {Promise<string>} Regex-transformed text, or raw text on failure
 */
export async function applyRegexToMessage(mes, isUser) {
    if (!mes || typeof mes !== 'string') {
        return mes;
    }

    if (!_regexModule && !_loadAttempted) {
        _loadAttempted = true;
        try {
            const enginePath = '../../../../scripts/extensions/regex/engine.js';
            _regexModule = await import(/* @vite-ignore */ enginePath);
        } catch (e) {
            console.warn(
                '[Summaryception] Regex engine unavailable, using raw text.',
                e?.message || e,
            );
        }
    }

    if (!_regexModule) {
        return mes;
    }

    try {
        const placement = isUser
            ? _regexModule.regex_placement.USER_INPUT
            : _regexModule.regex_placement.AI_OUTPUT;
        const result = _regexModule.getRegexedString(mes, placement);
        const speaker = isUser ? 'Player' : 'Assistant';
        trace(
            `  regex ${speaker}: ${mes.length} chars → ${result.length} chars ` +
                `(delta: ${result.length - mes.length >= 0 ? '+' : ''}${result.length - mes.length})`,
        );
        return result;
    } catch (e) {
        console.warn(
            '[Summaryception] Regex transformation failed, using raw text.',
            e?.message || e,
        );
        return mes;
    }
}
