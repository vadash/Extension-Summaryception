import { getChat } from '../foundation/context.js';
import { ensureChatScIds } from '../foundation/message-identity.js';
import { getChatStore } from '../foundation/chat-store.js';
import { persistChatState } from './persist-state.js';

/**
 * Assign stable IDs without changing chat contents.
 * @returns {Promise<{ chat: ChatMessage[], store: SummaryceptionStore }>}
 */
export async function prepareSummaryCycle() {
    const chat = getChat();
    const assigned = ensureChatScIds(chat);
    const store = getChatStore();
    if (assigned) {
        await persistChatState();
    }
    return { chat, store };
}
