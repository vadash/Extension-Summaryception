import { getChat } from '../foundation/context.js';
import { getChatStore } from '../foundation/chat-store.js';
import { removeMessageIdentities } from '../foundation/message-identity.js';
import { refreshFull } from '../foundation/refresh.js';
import { commitSnippetMutation } from './snippet-commit.js';
import { persistChatState } from './persist-state.js';
import { removeMessageTokenCaches } from './token-count.js';
import { removeContinuityCheckpoints } from './continuity-runner.js';

/**
 * Clear: remove every piece of Extension Chat Data from the chat and unhide its
 * messages, leaving the chat as if the extension had never run (ADR-0027). Each
 * shape is removed by the module that writes it, never by inspecting a key
 * name. The Chat Store is emptied in place through the Snippet Commit seam,
 * which also releases the Ghosting ownership and bumps the Mutation Epoch;
 * the chat file is then written once, by the one writer, and the visible state
 * and the injections re-render from the wiped chat.
 *
 * A step that fails leaves the wipe partial; the action is user-confirmed and
 * idempotent, so re-running it finishes the job.
 * @returns {Promise<void>} Throws to its caller when a step fails.
 */
export async function clearChatData() {
    const store = getChatStore();
    await commitSnippetMutation(
        store,
        () => {
            store.layers.length = 0;
        },
        { ghost: 'clear' },
    );

    const chat = getChat();
    removeMessageIdentities(chat);
    removeMessageTokenCaches(chat);
    removeContinuityCheckpoints(chat);

    await persistChatState({ chatSave: 'immediate' });
    refreshFull();
}
