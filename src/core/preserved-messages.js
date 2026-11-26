import {
    bumpSummaryStoreMutationEpoch,
    getChatStore,
    normalizePreservedMessages,
} from '../foundation/chat-store.js';
import { getMessageIndexByScId, resolveScIdsToIndices } from '../foundation/message-identity.js';
import { stripChineseIdeographs } from './cn-text.js';
import { formatMessageSpeakerLine, getPromptDepthsByChatIndex } from './chatutils.js';
import { unmaskGuardText } from './guard-mask.js';
import { normalizeCurrentDateTime } from './snippet-metadata.js';
import { getCurrentSummarizedBoundary } from './snippet-provenance.js';
import { applyRegexToMessage } from './regex-proxy.js';
import { buildInjection } from './memory-injection.js';

/**
 * @param {SummaryceptionStore} [store]
 * @returns {SummaryceptionPreservedMessage[]}
 */
export function getPreservedMessages(store = getChatStore()) {
    return normalizePreservedMessages(store?.preservedMessages);
}

/**
 * @param {SummaryceptionStore} [store]
 * @returns {string[]}
 */
export function getPreservedMessageIds(store = getChatStore()) {
    return getPreservedMessages(store).map((record) => record.id);
}

/**
 * @param {SummaryceptionStore} [store]
 * @returns {string[]}
 */
export function getHandedOffPreservedMessageIds(store = getChatStore()) {
    return getPreservedMessages(store)
        .filter((record) => record.handedOff)
        .map((record) => record.id);
}

/**
 * @param {ChatMessage | undefined} message
 * @param {SummaryceptionStore} [store]
 * @returns {boolean}
 */
export function isPreservedMessage(message, store = getChatStore()) {
    if (!store || typeof store !== 'object') {
        store = getChatStore();
    }
    const id = message?.sc_id;
    const records = store.preservedMessages;
    return (
        typeof id === 'string' &&
        id.trim() !== '' &&
        Array.isArray(records) &&
        records.some(
            (record) =>
                record?.id === id &&
                typeof record.text === 'string' &&
                record.text.trim() !== '' &&
                typeof record.handedOff === 'boolean' &&
                (record.currentDateTime === undefined ||
                    (typeof record.currentDateTime === 'string' &&
                        record.currentDateTime.trim() !== '')),
        )
    );
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} [store]
 * @returns {number[]}
 */
export function getPreservedMessageIndices(chat, store = getChatStore()) {
    return resolveScIdsToIndices(chat, getPreservedMessageIds(store));
}

/**
 * Drop records whose stable source identity no longer resolves. The caller
 * persists the repaired store through the normal Chat Persistence owner.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {boolean} Whether the store changed.
 */
export function reconcilePreservedMessages(chat, store) {
    const previous = Array.isArray(store.preservedMessages) ? store.preservedMessages : [];
    const liveIds = new Set(
        Array.isArray(chat)
            ? chat
                  .map((message) => message?.sc_id)
                  .filter((id) => typeof id === 'string' && id.trim() !== '')
            : [],
    );
    const next = normalizePreservedMessages(previous).filter((record) => liveIds.has(record.id));
    const changed =
        previous.length !== next.length ||
        next.some((record, index) => !samePreservedRecord(previous[index], record));
    store.preservedMessages = next;
    if (changed) {
        bumpSummaryStoreMutationEpoch(store);
    }
    return changed;
}

/**
 * @param {SummaryceptionPreservedMessage | undefined} left
 * @param {SummaryceptionPreservedMessage | undefined} right
 * @returns {boolean}
 */
function samePreservedRecord(left, right) {
    return (
        left?.id === right?.id &&
        left?.text === right?.text &&
        left?.currentDateTime === right?.currentDateTime &&
        left?.handedOff === right?.handedOff
    );
}

/**
 * @param {ChatMessage | undefined} message
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} [store]
 * @returns {{ eligible: boolean, reason: string, index?: number }}
 */
export function getPreservationEligibility(message, chat, store = getChatStore()) {
    const id = message?.sc_id;
    const index = typeof id === 'string' ? getMessageIndexByScId(chat).get(id) : undefined;
    if (!message || index === undefined) {
        return { eligible: false, reason: 'missing-identity' };
    }
    if (message.is_system || message.extra?.type) {
        return { eligible: false, reason: 'system', index };
    }
    if (message.is_hidden) {
        return { eligible: false, reason: 'hidden', index };
    }
    if (typeof message.is_user !== 'boolean' || !String(message.mes || '').trim()) {
        return { eligible: false, reason: 'empty', index };
    }
    if (index <= getCurrentSummarizedBoundary(chat, store)) {
        return { eligible: false, reason: 'summarized', index };
    }
    if (isPreservedMessage(message, store)) {
        return { eligible: false, reason: 'preserved', index };
    }
    return { eligible: true, reason: 'eligible', index };
}

/**
 * @typedef {object} PreservedMessageRenderOptions
 * @property {boolean} [regexAtAnyDepth=true] - Run prompt regex without source-depth filters.
 * @property {boolean} [stripCn=true] - Replace Han ideographs using the shared CN cleaner.
 * @property {boolean} [stripTags=false] - Remove markup tags while keeping visible text.
 */

/**
 * Build the exact speaker-labelled body proposed for approval. Scene Time comes
 * only from preceding Snippet memory, never from host message dates.
 * @param {ChatMessage | undefined} message
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {PreservedMessageRenderOptions} [options]
 * @returns {Promise<SummaryceptionPreservedMessage | null>}
 */
async function buildPreservedMessageSnapshot(message, chat, store, options = {}) {
    const { regexAtAnyDepth = true, stripCn = true, stripTags = false } = options;
    const eligibility = getPreservationEligibility(message, chat, store);
    const index = eligibility.index;
    if (
        !eligibility.eligible ||
        !message ||
        typeof message.sc_id !== 'string' ||
        index === undefined
    ) {
        return null;
    }
    const rawText = String(message.mes || '').trim();
    let rendered = regexAtAnyDepth
        ? await applyRegexToMessage(rawText, Boolean(message.is_user))
        : await applyRegexToMessage(
              rawText,
              Boolean(message.is_user),
              getPromptDepthsByChatIndex(chat).get(index),
          );
    if (stripCn) {
        rendered = stripChineseIdeographs(rendered);
    }
    if (stripTags) {
        rendered = stripMessageTags(rendered);
    }
    const body = escapePreservedTags(unmaskGuardText(rendered));
    if (!body.trim()) {
        return null;
    }
    const currentDateTime = findPrecedingSceneTime(chat, store, index);
    return Object.freeze({
        id: message.sc_id,
        text: formatMessageSpeakerLine(message, body),
        ...(currentDateTime ? { currentDateTime } : {}),
        handedOff: false,
    });
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapePreservedTags(text) {
    return text
        .replaceAll('</preserved>', '&lt;/preserved&gt;')
        .replaceAll('<preserved>', '&lt;preserved&gt;');
}

const MESSAGE_COMMENT_REGEX = /<!--[\s\S]*?-->/g;
const MESSAGE_LINE_BREAK_REGEX = /<br\s*\/?\s*>/gi;
const MESSAGE_TAG_REGEX = /<\/?[a-zA-Z][^<>]*>/g;
const EXCESS_BLANK_LINES_REGEX = /\n{3,}/g;

/**
 * Remove markup tags while keeping their visible text and line breaks.
 * @param {string} text
 * @returns {string}
 */
function stripMessageTags(text) {
    return String(text || '')
        .replace(MESSAGE_COMMENT_REGEX, '')
        .replace(MESSAGE_LINE_BREAK_REGEX, '\n')
        .replace(MESSAGE_TAG_REGEX, '')
        .replace(EXCESS_BLANK_LINES_REGEX, '\n\n')
        .trim();
}

/**
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @param {number} messageIndex
 * @returns {string | undefined}
 */
function findPrecedingSceneTime(chat, store, messageIndex) {
    let nearestEnd = -1;
    let sceneTime;
    for (const layer of store.layers || []) {
        for (const snippet of layer || []) {
            const indices = resolveScIdsToIndices(chat, snippet?.sourceMessageIds);
            const end = indices.at(-1);
            const candidate =
                typeof snippet?.currentDateTime === 'string' ? snippet.currentDateTime.trim() : '';
            if (
                end === undefined ||
                end >= messageIndex ||
                end < nearestEnd ||
                !candidate ||
                candidate.toLowerCase() === 'unknown'
            ) {
                continue;
            }
            nearestEnd = end;
            sceneTime = candidate;
        }
    }
    return sceneTime ? normalizeCurrentDateTime(sceneTime) : undefined;
}

/**
 * Latch the one-way handoff after a later Layer 0 commit advances across the
 * preserved source position. Snippet deletion and Promotion cannot reverse it.
 * @param {ChatMessage[]} chat
 * @param {SummaryceptionStore} store
 * @returns {boolean} Whether any record latched.
 */
export function latchPreservedHandoffs(chat, store) {
    const boundary = getCurrentSummarizedBoundary(chat, store);
    const messageIndices = getMessageIndexByScId(chat);
    let changed = false;
    store.preservedMessages = store.preservedMessages.map((record) => {
        const index = messageIndices.get(record.id);
        if (record.handedOff || index === undefined || index > boundary) {
            return record;
        }
        changed = true;
        return Object.freeze({ ...record, handedOff: true });
    });
    return changed;
}

const PRESERVED_APPROVAL_DEFAULT_OPTIONS = Object.freeze({
    regexAtAnyDepth: true,
    stripCn: true,
    stripTags: false,
});

/**
 * Build the one Preserved Message approval transaction. The composition root
 * builds one instance with live runtime readers and the Gate, Queue, and
 * persistence collaborators, then entry calls one operation per approval.
 * Core owns candidate construction, preview, confirmation handling, freshness,
 * validation, and commit. Entry owns Popup, DOM, notices, and refresh.
 * @param {object} deps
 * @param {() => ChatMessage[]} deps.getChat - Live chat reader.
 * @param {() => SummaryceptionStore} deps.getChatStore - Live Chat Store reader.
 * @param {() => ExtensionSettings} deps.getEffectiveSettings - Live effective settings reader.
 * @param {() => object} deps.getContext - Live host context reader.
 * @param {(ctx: object) => string} deps.getChatIdentity - Chat identity seam.
 * @param {() => boolean} deps.isGenerating - Live generation flag reader.
 * @param {{ isFrozen: () => boolean }} deps.gate - Foreground Gate.
 * @param {{ isBusy: () => boolean }} deps.queue - Summarizer Queue.
 * @param {() => Promise<void>} deps.saveChatStore - Injected persistence.
 * @returns {{ approve: (request: { messageId: string, confirm: object, options?: PreservedMessageRenderOptions }) => Promise<{ status: string, reason?: string, record?: SummaryceptionPreservedMessage, epoch?: number }> }}
 */
export function createPreservedMessageApproval(deps) {
    const valid = isApprovalDepsValid(deps);
    if (!valid) {
        throw new Error(
            'createPreservedMessageApproval needs live readers, Gate, Queue, and persistence.',
        );
    }
    return {
        approve: (request) => runApprovalTransaction(deps, request),
    };
}

function isApprovalDepsValid(deps) {
    return (
        !!deps &&
        typeof deps.getChat === 'function' &&
        typeof deps.getChatStore === 'function' &&
        typeof deps.getEffectiveSettings === 'function' &&
        typeof deps.getContext === 'function' &&
        typeof deps.getChatIdentity === 'function' &&
        typeof deps.isGenerating === 'function' &&
        !!deps.gate &&
        typeof deps.gate.isFrozen === 'function' &&
        !!deps.queue &&
        typeof deps.queue.isBusy === 'function' &&
        typeof deps.saveChatStore === 'function'
    );
}

function normalizeApprovalOptions(value) {
    return { ...PRESERVED_APPROVAL_DEFAULT_OPTIONS, ...(value || {}) };
}

function parseApprovedRevision(result) {
    if (typeof result === 'number' || typeof result === 'string') {
        return result;
    }
    if (!result || typeof result !== 'object') {
        return null;
    }
    if (result.approved === true && result.revision !== undefined) {
        return result.revision;
    }
    if (result.status === 'approved' && result.revision !== undefined) {
        return result.revision;
    }
    if (result.decision === 'approved' && result.revision !== undefined) {
        return result.revision;
    }
    return null;
}

function readApprovalGuard(deps) {
    if (!deps.getEffectiveSettings().enabled) {
        return 'disabled';
    }
    if (deps.queue.isBusy()) {
        return 'busy';
    }
    if (deps.gate.isFrozen()) {
        return 'frozen';
    }
    if (deps.isGenerating()) {
        return 'generating';
    }
    return null;
}

function isMessageIdValid(messageId) {
    return typeof messageId === 'string' && messageId.trim() !== '';
}

function resolveCurrentTarget(deps, messageId) {
    const chat = deps.getChat();
    const store = deps.getChatStore();
    const chatId = deps.getChatIdentity(deps.getContext());
    const index = getMessageIndexByScId(chat).get(messageId);
    const message = index !== undefined ? chat[index] : undefined;
    return { chat, store, chatId, index, message };
}

function checkInitialTarget(deps, messageId) {
    const target = resolveCurrentTarget(deps, messageId);
    if (!target.message || target.message.sc_id !== messageId || target.index === undefined) {
        return { ok: false, reason: 'missing-identity' };
    }
    const eligibility = getPreservationEligibility(target.message, target.chat, target.store);
    if (!eligibility.eligible) {
        return { ok: false, reason: eligibility.reason };
    }
    return { ok: true, target };
}

async function buildApprovalCandidate(deps, messageId, normalized) {
    const target = resolveCurrentTarget(deps, messageId);
    if (!target.message || target.message.sc_id !== messageId || target.index === undefined) {
        return { ok: false, reason: 'missing-identity' };
    }
    const eligibility = getPreservationEligibility(target.message, target.chat, target.store);
    if (!eligibility.eligible) {
        return { ok: false, reason: eligibility.reason };
    }
    const snapshot = await buildPreservedMessageSnapshot(
        target.message,
        target.chat,
        target.store,
        normalized,
    );
    if (!snapshot) {
        return { ok: false, reason: 'empty' };
    }
    const preview = buildInjection(target.store.layers, deps.getEffectiveSettings(), null, {
        chat: target.chat,
        preservedMessages: [...target.store.preservedMessages, { ...snapshot, handedOff: true }],
    }).text;
    if (!preview.trim() || !preview.includes('<preserved>')) {
        return { ok: false, reason: 'unavailable' };
    }
    return {
        ok: true,
        snapshot,
        preview,
        chatId: target.chatId,
        index: target.index,
        rawMes: String(target.message.mes),
        isUser: Boolean(target.message.is_user),
    };
}

function createApprovalState(initialOptions, initial) {
    const candidates = new Map();
    candidates.set(1, {
        snapshot: initial.snapshot,
        preview: initial.preview,
        options: initialOptions,
        chatId: initial.chatId,
        index: initial.index,
        rawMes: initial.rawMes,
        isUser: initial.isUser,
        reason: null,
    });
    return { candidates, nextRevision: 1, latestRevision: 1, pendingRerenders: 0 };
}

function storeRerenderedCandidate(state, revision, built, normalized) {
    if (built.ok) {
        state.candidates.set(revision, {
            snapshot: built.snapshot,
            preview: built.preview,
            options: normalized,
            chatId: built.chatId,
            index: built.index,
            rawMes: built.rawMes,
            isUser: built.isUser,
            reason: null,
        });
        return built.preview;
    }
    state.candidates.set(revision, {
        snapshot: null,
        preview: '',
        options: normalized,
        chatId: null,
        index: null,
        rawMes: null,
        isUser: null,
        reason: built.reason,
    });
    return '';
}

async function rerenderApprovalCandidate(deps, state, messageId, nextOptions) {
    const normalized = normalizeApprovalOptions(nextOptions);
    state.pendingRerenders += 1;
    try {
        const built = await buildApprovalCandidate(deps, messageId, normalized);
        state.nextRevision += 1;
        const revision = state.nextRevision;
        const preview = storeRerenderedCandidate(state, revision, built, normalized);
        state.latestRevision = revision;
        return { revision, preview };
    } finally {
        state.pendingRerenders -= 1;
    }
}

async function invokeApprovalConfirm(confirm, preview, revision, rerender) {
    if (!confirm || typeof confirm.show !== 'function') {
        return { status: 'skipped', reason: 'unavailable' };
    }
    try {
        const decision = await confirm.show({ preview, revision, rerender });
        const approvedRevision = parseApprovedRevision(decision);
        if (approvedRevision === null) {
            return { status: 'skipped', reason: 'cancelled' };
        }
        return { status: 'ok', revision: approvedRevision };
    } catch {
        return { status: 'skipped', reason: 'unavailable' };
    }
}

function resolveApprovalRevision(state, approvedRevision) {
    if (state.pendingRerenders > 0) {
        return { status: 'stale' };
    }
    if (approvedRevision !== state.latestRevision || !state.candidates.has(approvedRevision)) {
        return { status: 'stale' };
    }
    const approved = state.candidates.get(approvedRevision);
    if (!approved.snapshot) {
        if (approved.reason === 'missing-identity' || approved.reason === 'ineligible') {
            return { status: 'stale' };
        }
        return { status: 'skipped', reason: approved.reason || 'empty' };
    }
    return { status: 'ok', approved };
}

function isIdentityFresh(current, messageId, approved) {
    if (!current.message || current.message.sc_id !== messageId || current.index === undefined) {
        return false;
    }
    if (current.chatId !== approved.chatId) {
        return false;
    }
    if (current.index !== approved.index) {
        return false;
    }
    return (
        String(current.message.mes) === approved.rawMes &&
        Boolean(current.message.is_user) === approved.isUser
    );
}

async function isRenderFresh(current, approved) {
    const fresh = await buildPreservedMessageSnapshot(
        current.message,
        current.chat,
        current.store,
        approved.options,
    );
    if (!fresh) {
        return false;
    }
    return (
        fresh.id === approved.snapshot.id &&
        fresh.text === approved.snapshot.text &&
        (fresh.currentDateTime || undefined) === (approved.snapshot.currentDateTime || undefined)
    );
}

async function validateApprovalFreshness(deps, messageId, approved) {
    const current = resolveCurrentTarget(deps, messageId);
    if (!isIdentityFresh(current, messageId, approved)) {
        return { ok: false };
    }
    if (!getPreservationEligibility(current.message, current.chat, current.store).eligible) {
        return { ok: false };
    }
    if (!(await isRenderFresh(current, approved))) {
        return { ok: false };
    }
    return { ok: true };
}

async function commitApprovedRecord(deps, messageId, snapshot) {
    const store = deps.getChatStore();
    if (
        Array.isArray(store.preservedMessages) &&
        store.preservedMessages.some((record) => record?.id === messageId)
    ) {
        return { status: 'stale' };
    }
    const previousRecords = store.preservedMessages;
    const previousEpoch = store.mutationEpoch;
    store.preservedMessages = [...previousRecords, snapshot];
    const epoch = bumpSummaryStoreMutationEpoch(store);
    try {
        await deps.saveChatStore();
    } catch (error) {
        store.preservedMessages = previousRecords;
        store.mutationEpoch = previousEpoch;
        throw error;
    }
    return { status: 'committed', record: snapshot, epoch };
}

async function runApprovalTransaction(deps, request) {
    const { messageId, confirm, options } = request ?? {};
    if (!isMessageIdValid(messageId)) {
        return { status: 'skipped', reason: 'missing-identity' };
    }
    const initialOptions = normalizeApprovalOptions(options);
    const preGuard = readApprovalGuard(deps);
    if (preGuard) {
        return { status: 'skipped', reason: preGuard };
    }
    const initialCheck = checkInitialTarget(deps, messageId);
    if (!initialCheck.ok) {
        return { status: 'skipped', reason: initialCheck.reason };
    }
    const initial = await buildApprovalCandidate(deps, messageId, initialOptions);
    if (!initial.ok) {
        return { status: 'skipped', reason: initial.reason };
    }
    const state = createApprovalState(initialOptions, initial);
    const rerender = (nextOptions) =>
        rerenderApprovalCandidate(deps, state, messageId, nextOptions);
    const confirmation = await invokeApprovalConfirm(confirm, initial.preview, 1, rerender);
    if (confirmation.status !== 'ok') {
        return { status: 'skipped', reason: confirmation.reason };
    }
    const resolution = resolveApprovalRevision(state, confirmation.revision);
    if (resolution.status !== 'ok') {
        return resolution.status === 'stale'
            ? { status: 'stale' }
            : { status: 'skipped', reason: resolution.reason };
    }
    const postGuard = readApprovalGuard(deps);
    if (postGuard) {
        return { status: 'skipped', reason: postGuard };
    }
    const freshness = await validateApprovalFreshness(deps, messageId, resolution.approved);
    if (!freshness.ok) {
        return { status: 'stale' };
    }
    return commitApprovedRecord(deps, messageId, resolution.approved.snapshot);
}
