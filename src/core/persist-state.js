import { warn } from '../foundation/logger.js';
import { getChatStore } from '../foundation/chat-store.js';

const CHAT_SAVE_DEBOUNCE_MS = 1500;

/** @typedef {'immediate' | 'deferred'} ChatSaveMode */

/** @type {ReturnType<typeof setTimeout> | null} */
let chatSaveTimer = null;

/**
 * Host save functions; the composition root initializes this one holder
 * (ADR-0031), tests re-initialize it through the same seam.
 * @type {{ saveChat: () => Promise<void>, saveMetadata: () => Promise<void> } | null}
 */
let persistence = null;

/**
 * @param {{ saveChat: () => Promise<void>, saveMetadata: () => Promise<void> }} host
 * @returns {void}
 */
export function initChatPersistence({ saveChat, saveMetadata }) {
    persistence = { saveChat, saveMetadata };
}

/**
 * @returns {{ saveChat: () => Promise<void>, saveMetadata: () => Promise<void> }}
 */
function requirePersistence() {
    if (!persistence) {
        throw new Error(
            'Chat Persistence is not initialized; the composition root must call initChatPersistence first.',
        );
    }
    return persistence;
}

/**
 * Persist chat metadata and chat state in one step.
 * Metadata is always saved immediately; chat file writes may be deferred.
 * @param {{ chatSave?: ChatSaveMode }} [options]
 * @returns {Promise<void>}
 */
export async function persistChatState({ chatSave = 'immediate' } = {}) {
    await getChatStore();
    await requirePersistence().saveMetadata();

    if (chatSave === 'deferred') {
        scheduleChatSave();
        return;
    }

    await saveChatImmediately();
}

/**
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
    const { saveChat } = requirePersistence();
    try {
        await saveChat();
    } catch (e) {
        warn('Could not save chat:', e);
    }
}
