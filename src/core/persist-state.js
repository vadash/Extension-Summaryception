import { saveChat } from '../foundation/context.js';
import { log } from '../foundation/logger.js';
import { saveChatStore } from '../foundation/state.js';

const CHAT_SAVE_DEBOUNCE_MS = 1500;

/** @typedef {'immediate' | 'deferred'} ChatSaveMode */

/** @type {ReturnType<typeof setTimeout> | null} */
let chatSaveTimer = null;

/**
 * Persist chat metadata and chat state in one step.
 * Metadata is always saved immediately; chat file writes may be deferred.
 * @param {{ chatSave?: ChatSaveMode }} [options]
 * @returns {Promise<void>}
 */
export async function persistChatState({ chatSave = 'immediate' } = {}) {
    await saveChatStore();

    if (chatSave === 'deferred') {
        scheduleChatSave();
        return;
    }

    await saveChatImmediately();
}

/**
 * Flush a pending debounced chat-file write, if one exists.
 * @returns {Promise<void>}
 */
export async function flushPendingChatSave() {
    if (!chatSaveTimer) {
        return;
    }

    clearScheduledChatSave();
    await saveChatSafely();
}

async function saveChatImmediately() {
    clearScheduledChatSave();
    await saveChatSafely();
}

function scheduleChatSave() {
    clearScheduledChatSave();
    chatSaveTimer = setTimeout(() => {
        chatSaveTimer = null;
        void saveChatSafely();
    }, CHAT_SAVE_DEBOUNCE_MS);
}

function clearScheduledChatSave() {
    if (!chatSaveTimer) {
        return;
    }

    clearTimeout(chatSaveTimer);
    chatSaveTimer = null;
}

async function saveChatSafely() {
    try {
        await saveChat();
    } catch (e) {
        log('Could not save chat:', e);
    }
}

function flushPendingChatSaveOnUnload() {
    if (!chatSaveTimer) {
        return;
    }

    clearScheduledChatSave();
    void saveChatSafely();
}

function registerLifecycleFlush() {
    if (typeof globalThis.addEventListener !== 'function') {
        return;
    }

    globalThis.addEventListener('pagehide', flushPendingChatSaveOnUnload);
    globalThis.addEventListener('beforeunload', flushPendingChatSaveOnUnload);
}

registerLifecycleFlush();
