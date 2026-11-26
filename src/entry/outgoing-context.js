import { getActiveModelName, getChat } from '../foundation/context.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { EXTENSION_PROMPT_POSITIONS, EXTENSION_PROMPT_ROLES } from '../foundation/constants.js';
import {
    expandMicroficheContent,
    resolveMicroficheStubPage,
} from '../core/microfiche-transport.js';

/**
 * @typedef {object} OutgoingSlotFacts
 * @property {string} text - Last committed slot text.
 * @property {{ position: number, depth: number, scan: boolean, role: number } | null | undefined} [options] - Committed placement.
 * @property {boolean} [hasSlot] - Whether the committed copy occupies the prompt.
 * @property {string} [lastInjectionKey] - Key of the last host write.
 */
/**
 * @typedef {(pageIndex: number, region?: import('../core/microfiche-transport.js').MicroficheRegion) => ({ dataUrl: string, text: string } | undefined)} MicrofichePageReader
 */

/**
 * @typedef {object} OutgoingContextWriter
 * @property {() => OutgoingSlotFacts} [getSlotFacts] - Read-only committed slot facts.
 * @property {MicrofichePageReader} [resolveMicrofichePage] - Writer page reader.
 */

/**
 * @typedef {object} OutgoingContextOptions
 * @property {OutgoingContextWriter | null} [writer] - Shared writer.
 * @property {Partial<ExtensionSettings> | null} [settings] - Effective settings override.
 * @property {unknown} [chat] - Live chat override.
 * @property {unknown} [modelName] - Active model name override.
 * @property {MicrofichePageReader} [resolvePage] - Expansion reader override.
 */

/**
 * Build the frozen core context for one outgoing rewrite. Entry owns every
 * host read here so the core stays host-free: effective settings, the model
 * verdict behind the active model name, the chat-tail anchor, and the
 * structural slot identity. The prompt assembly and Microfiche expansion stay
 * outside; this module only matches the assembled messages.
 * @param {Array<Record<string, unknown>> | unknown} messages - Assembled prompt messages.
 * @param {OutgoingContextOptions} [options] - Writer and fact overrides; overrides keep tests host-free.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingFrozenContext} Frozen context.
 */
export function buildOutgoingContext(messages, options = {}) {
    const facts = captureEntryFacts(options);
    const coreSettings = projectCoreSettings(facts.settings);
    const slot = resolveSlotIdentity(messages, facts.slotFacts, {
        resolvePage: facts.resolvePage,
        settings: facts.settings,
    });

    return Object.freeze({
        ...coreSettings,
        guardEnabled: resolveGuardVerdict(facts.settings, facts.modelName),
        chatTailAnchor: readChatTailAnchor(facts.chat),
        slot: Object.freeze(slot),
    });
}

/**
 * Capture every host-owned fact in one place so the builder stays flat.
 * @param {OutgoingContextOptions} options - Writer and overrides.
 * @returns {{ settings: Partial<ExtensionSettings>, modelName: string, chat: unknown, resolvePage: MicrofichePageReader, slotFacts: OutgoingSlotFacts | null }} Captured facts.
 */
function captureEntryFacts(options) {
    const writer = options.writer ?? null;
    return {
        settings: readSettings(options),
        modelName: readModelName(options),
        chat: readChat(options),
        resolvePage: readResolvePage(options, writer),
        slotFacts: readSlotFacts(writer),
    };
}

/**
 * Project the core-owned settings slice without verdict or anchor facts.
 * @param {Partial<ExtensionSettings>} settings - Effective settings.
 * @returns {{ enabled: boolean, stripChineseIdeographs: boolean, maskUserRoleAsAssistant: boolean, maskUserRoleMode: string | undefined, guardMaskMemory: boolean, guardMaskCotMode: string | undefined, guardMaskCotCount: number | undefined }} Core settings slice.
 */
function projectCoreSettings(settings) {
    return {
        enabled: Boolean(settings?.enabled),
        stripChineseIdeographs: Boolean(settings?.stripChineseIdeographs),
        maskUserRoleAsAssistant: Boolean(settings?.maskUserRoleAsAssistant),
        maskUserRoleMode:
            typeof settings?.maskUserRoleMode === 'string' ? settings.maskUserRoleMode : undefined,
        guardMaskMemory: Boolean(settings?.guardMaskMemory),
        guardMaskCotMode:
            typeof settings?.guardMaskCotMode === 'string' ? settings.guardMaskCotMode : undefined,
        guardMaskCotCount:
            typeof settings?.guardMaskCotCount === 'number'
                ? settings.guardMaskCotCount
                : undefined,
    };
}

/**
 * The model gate lives here so the core never reads the host model name.
 * @param {Partial<ExtensionSettings>} settings - Effective settings.
 * @param {string} modelName - Active model name.
 * @returns {boolean} Guard branch verdict.
 */
function resolveGuardVerdict(settings, modelName) {
    return Boolean(settings?.guardMask) && /argon|opus|gemini/i.test(String(modelName ?? ''));
}

/**
 * @param {OutgoingContextOptions} options
 * @returns {Partial<ExtensionSettings>} Effective settings or an empty fallback.
 */
function readSettings(options) {
    if (options.settings !== undefined && options.settings !== null) {
        return options.settings;
    }
    try {
        return getEffectiveSettings();
    } catch {
        return {};
    }
}

/**
 * @param {OutgoingContextOptions} options
 * @returns {string} Active model name or empty when unreadable.
 */
function readModelName(options) {
    if (options.modelName !== undefined) {
        return String(options.modelName ?? '');
    }
    try {
        return String(getActiveModelName() ?? '');
    } catch {
        return '';
    }
}

/**
 * @param {OutgoingContextOptions} options
 * @returns {unknown} Live chat or null when unreadable.
 */
function readChat(options) {
    if (options.chat !== undefined) {
        return options.chat;
    }
    try {
        return getChat();
    } catch {
        return null;
    }
}

/**
 * @param {OutgoingContextOptions} options
 * @param {OutgoingContextWriter | null} writer
 * @returns {MicrofichePageReader} Expansion reader.
 */
function readResolvePage(options, writer) {
    if (typeof options.resolvePage === 'function') {
        return options.resolvePage;
    }
    if (writer && typeof writer.resolveMicrofichePage === 'function') {
        return writer.resolveMicrofichePage;
    }
    return resolveMicroficheStubPage;
}

/**
 * @param {OutgoingContextWriter | null | undefined} writer
 * @returns {OutgoingSlotFacts | null} Committed facts or null when missing.
 */
function readSlotFacts(writer) {
    try {
        const facts = writer?.getSlotFacts?.();
        if (!facts || typeof facts !== 'object') {
            return null;
        }
        return facts;
    } catch {
        return null;
    }
}

/**
 * The trailing Preset CoT window anchors on the live chat tail. The core keeps
 * the anchoring policy; entry only supplies the captured text.
 * @param {unknown} chat - Live chat array.
 * @returns {string | null} Last chat text or null when empty.
 */
function readChatTailAnchor(chat) {
    if (!Array.isArray(chat) || chat.length === 0) {
        return null;
    }
    const last = chat[chat.length - 1];
    const anchor = readAnchorText(last);
    const trimmed = String(anchor ?? '').trim();
    return trimmed ? String(anchor) : null;
}

/**
 * @param {unknown} last - Last chat entry.
 * @returns {string} Raw anchor text.
 */
function readAnchorText(last) {
    if (!last || typeof last !== 'object') {
        return '';
    }
    const record = /** @type {{ mes?: unknown, content?: unknown }} */ (last);
    if (typeof record.mes === 'string') {
        return record.mes;
    }
    if (typeof record.content === 'string') {
        return record.content;
    }
    if (Array.isArray(record.content)) {
        const parts = /** @type {Array<unknown>} */ (record.content);
        return parts
            .map((part) => {
                if (!part || typeof part !== 'object') {
                    return '';
                }
                const entry = /** @type {{ text?: unknown }} */ (part);
                return typeof entry.text === 'string' ? entry.text : '';
            })
            .join('');
    }
    return '';
}

/**
 * Match the assembled prompt against the committed slot copy. A placed slot
 * needs one unique structural match with the committed role; zero or several
 * matches stay unresolved so the core over-masks instead of skipping the wrong
 * message. Repeated template placeholders already collapsed into the committed
 * text, so one message still counts as one logical slot.
 * @param {Array<Record<string, unknown>> | unknown} messages - Assembled prompt.
 * @param {OutgoingSlotFacts | null} slotFacts - Committed writer facts.
 * @param {{ resolvePage?: MicrofichePageReader, settings?: Partial<ExtensionSettings> }} [deps] - Expansion reader and settings.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} Structural identity.
 */
function resolveSlotIdentity(messages, slotFacts, { resolvePage, settings } = {}) {
    const placement = classifyPlacement(slotFacts, settings);
    if (placement.kind !== 'ok') {
        return placement.slot;
    }
    if (!Array.isArray(messages)) {
        return unresolvedSlot('missing-prompt');
    }
    const prompt = /** @type {Array<Record<string, unknown>>} */ (messages);
    const expectedRole = roleString(placement.role);
    const stringCandidates = collectStringCandidates(prompt, placement.text, expectedRole);
    const reader = typeof resolvePage === 'function' ? resolvePage : resolveMicroficheStubPage;
    const expansion = expandSlotExpectation(placement.text, reader);
    if (expansion.kind === 'string') {
        return decideStringOnly(stringCandidates, placement.text);
    }
    const partCandidates = collectPartCandidates(prompt, expansion.expectedParts, expectedRole);
    return decideExpanded(
        stringCandidates,
        partCandidates,
        placement.text,
        expansion.expectedParts,
    );
}

/**
 * @param {OutgoingSlotFacts | null} slotFacts - Committed writer facts.
 * @param {Partial<ExtensionSettings> | undefined} settings - Effective settings.
 * @returns {{ kind: 'ok', text: string, role: unknown } | { kind: 'settled', slot: import('../core/outgoing-rewrite.js').OutgoingSlotIdentity }} Placement verdict.
 */
function classifyPlacement(slotFacts, settings) {
    if (!settings?.enabled) {
        return { kind: 'settled', slot: absentSlot() };
    }
    if (!slotFacts || typeof slotFacts !== 'object') {
        return { kind: 'settled', slot: unresolvedSlot('missing-facts') };
    }
    const text = typeof slotFacts.text === 'string' ? slotFacts.text : '';
    const position = slotFacts.options?.position;
    if (isAbsentPlacement(slotFacts, text, position)) {
        if (text !== '' && !isExplicitlyAbsent(slotFacts, text, position)) {
            return { kind: 'settled', slot: unresolvedSlot('missing-facts') };
        }
        return { kind: 'settled', slot: absentSlot() };
    }
    return { kind: 'ok', text, role: slotFacts.options?.role };
}

/**
 * Macro-only, empty, and disabled placements never occupy the prompt.
 * @param {OutgoingSlotFacts} slotFacts - Committed writer facts.
 * @param {string} text - Committed slot text.
 * @param {unknown} position - Committed placement position.
 * @returns {boolean} Whether the facts declare an absent slot.
 */
function isExplicitlyAbsent(slotFacts, text, position) {
    return (
        slotFacts.hasSlot === false || text === '' || position === EXTENSION_PROMPT_POSITIONS.NONE
    );
}

/**
 * A slot is present only with committed text, an explicit presence flag, and
 * a prompt placement. Anything else settles as absent above.
 * @param {OutgoingSlotFacts} slotFacts - Committed writer facts.
 * @param {string} text - Committed slot text.
 * @param {unknown} position - Committed placement position.
 * @returns {boolean} Whether the slot is absent.
 */
function isAbsentPlacement(slotFacts, text, position) {
    const hasSlot =
        slotFacts.hasSlot === true && text !== '' && position !== EXTENSION_PROMPT_POSITIONS.NONE;
    return isExplicitlyAbsent(slotFacts, text, position) || !hasSlot;
}

/**
 * Expand the committed text through the transport seam. Markers become an
 * image-opaque part list; anything else stays a plain string comparison.
 * @param {string} text - Committed slot text.
 * @param {MicrofichePageReader} resolvePage - Page reader.
 * @returns {{ kind: 'string' } | { kind: 'parts', expectedParts: Array<string | null> }} Expansion verdict.
 */
function expandSlotExpectation(text, resolvePage) {
    /** @type {{ swapped: number, content: Array<unknown> } | null} */
    let expanded = null;
    try {
        const result = expandMicroficheContent(text, resolvePage);
        if (isPartsExpansion(result)) {
            expanded = { swapped: result.swapped, content: result.content };
        }
    } catch {
        expanded = null;
    }
    if (!expanded) {
        return { kind: 'string' };
    }
    /** @type {Array<string | null>} */
    const expectedParts = /** @type {Array<string | null>} */ (
        /** @type {unknown} */ (
            Object.freeze(
                expanded.content.map((part) => {
                    if (!part || typeof part !== 'object') {
                        return null;
                    }
                    const entry = /** @type {{ text?: unknown }} */ (part);
                    return typeof entry.text === 'string' ? entry.text : null;
                }),
            )
        )
    );
    return { kind: 'parts', expectedParts };
}

/**
 * @param {unknown} expanded - Transport expansion result.
 * @returns {expanded is { swapped: number, content: Array<unknown> }} Whether markers resolved to a part list.
 */
function isPartsExpansion(expanded) {
    if (!expanded || typeof expanded !== 'object') {
        return false;
    }
    const record = /** @type {{ swapped?: unknown, content?: unknown }} */ (expanded);
    return (
        typeof record.swapped === 'number' && record.swapped > 0 && Array.isArray(record.content)
    );
}

/**
 * @param {Array<Record<string, unknown>>} messages - Assembled prompt.
 * @param {string} text - Committed string text.
 * @param {string} expectedRole - Committed prompt role.
 * @returns {Array<Record<string, unknown>>} String matches.
 */
function collectStringCandidates(messages, text, expectedRole) {
    return messages.filter((message) => isStringCandidate(message, text, expectedRole));
}

/**
 * @param {Array<Record<string, unknown>>} messages - Assembled prompt.
 * @param {Array<string | null>} expectedParts - Frozen expected part text.
 * @param {string} expectedRole - Committed prompt role.
 * @returns {Array<Record<string, unknown>>} Multipart matches.
 */
function collectPartCandidates(messages, expectedParts, expectedRole) {
    return messages.filter((message) => isPartsCandidate(message, expectedParts, expectedRole));
}

/**
 * @param {Array<Record<string, unknown>>} candidates - String matches.
 * @param {string} text - Committed string text.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} String verdict.
 */
function decideStringOnly(candidates, text) {
    if (candidates.length === 1) {
        return placedStringSlot(candidates[0], text);
    }
    return unresolvedSlot(candidates.length === 0 ? 'no-match' : 'ambiguous');
}

/**
 * Prefer the single form that matches; mixed or duplicate matches stay
 * unresolved so the core over-masks instead of guessing.
 * @param {Array<Record<string, unknown>>} stringCandidates - String matches.
 * @param {Array<Record<string, unknown>>} partCandidates - Multipart matches.
 * @param {string} text - Committed string text.
 * @param {Array<string | null>} expectedParts - Frozen expected part text.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} Expanded verdict.
 */
function decideExpanded(stringCandidates, partCandidates, text, expectedParts) {
    if (stringCandidates.length === 1 && partCandidates.length === 0) {
        return placedStringSlot(stringCandidates[0], text);
    }
    if (partCandidates.length === 1 && stringCandidates.length === 0) {
        return placedPartsSlot(partCandidates[0], expectedParts);
    }
    return unresolvedSlot(
        stringCandidates.length + partCandidates.length === 0 ? 'no-match' : 'ambiguous',
    );
}

/**
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} Absent identity.
 */
function absentSlot() {
    return { state: 'absent', message: null, expectedText: null, expectedParts: null };
}

/**
 * @param {string} reason - Unresolved classification.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} Unresolved identity.
 */
function unresolvedSlot(reason) {
    return {
        state: 'unresolved',
        message: null,
        expectedText: null,
        expectedParts: null,
        reason,
    };
}

/**
 * @param {Record<string, unknown>} message - Exact slot reference.
 * @param {string} text - Frozen string text.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} Placed string identity.
 */
function placedStringSlot(message, text) {
    return { state: 'placed', message, expectedText: text, expectedParts: null };
}

/**
 * @param {Record<string, unknown>} message - Exact slot reference.
 * @param {Array<string | null>} expectedParts - Frozen expected part text.
 * @returns {import('../core/outgoing-rewrite.js').OutgoingSlotIdentity} Placed multipart identity.
 */
function placedPartsSlot(message, expectedParts) {
    return { state: 'placed', message, expectedText: null, expectedParts };
}

/**
 * @param {unknown} role - Committed numeric role.
 * @returns {string} Prompt role the slot ships as.
 */
function roleString(role) {
    if (role === EXTENSION_PROMPT_ROLES.USER) {
        return 'user';
    }
    if (role === EXTENSION_PROMPT_ROLES.ASSISTANT) {
        return 'assistant';
    }
    return 'system';
}

/**
 * @param {unknown} message - Candidate prompt message.
 * @param {string} text - Committed string text.
 * @param {string} expectedRole - Committed prompt role.
 * @returns {boolean} Whether the message carries the exact committed string.
 */
function isStringCandidate(message, text, expectedRole) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    const record = /** @type {{ role?: unknown, content?: unknown }} */ (message);
    return record.role === expectedRole && record.content === text;
}

/**
 * @param {unknown} message - Candidate prompt message.
 * @param {Array<string | null>} expectedParts - Frozen expected part text.
 * @param {string} expectedRole - Committed prompt role.
 * @returns {boolean} Whether the multipart structure matches the expansion.
 */
function isPartsCandidate(message, expectedParts, expectedRole) {
    if (!message || typeof message !== 'object') {
        return false;
    }
    const record = /** @type {{ role?: unknown, content?: unknown }} */ (message);
    if (record.role !== expectedRole) {
        return false;
    }
    if (!Array.isArray(record.content)) {
        return false;
    }
    const content = /** @type {Array<unknown>} */ (record.content);
    if (content.length !== expectedParts.length) {
        return false;
    }
    for (let index = 0; index < expectedParts.length; index++) {
        const part = content[index];
        if (!part || typeof part !== 'object') {
            if (expectedParts[index] !== null) {
                return false;
            }
            continue;
        }
        const entry = /** @type {{ text?: unknown }} */ (part);
        const current = typeof entry.text === 'string' ? entry.text : null;
        if (current !== expectedParts[index]) {
            return false;
        }
    }
    return true;
}
