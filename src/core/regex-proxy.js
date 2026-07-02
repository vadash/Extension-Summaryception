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

const REGEX_ENGINE_PATHS = [
    '../../../../regex/engine.js',
    '../../../regex/engine.js',
    '/scripts/extensions/regex/engine.js',
];

async function loadRegexModule() {
    const failures = [];

    for (const enginePath of REGEX_ENGINE_PATHS) {
        try {
            return await import(/* @vite-ignore */ enginePath);
        } catch (e) {
            failures.push(`${enginePath}: ${e?.message || e}`);
        }
    }

    console.warn(
        '[Summaryception] Regex engine unavailable, using raw text.',
        failures.join(' | '),
    );
    return null;
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
        const result = _regexModule.getRegexedString(mes, placement, {
            isPrompt: true,
            depth,
        });
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
