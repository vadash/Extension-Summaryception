import { describe, expect, it } from 'vitest';

import { onAppReady } from '../src/entry/events.js';
import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { makeMessage, makeSummaryStore, installSummaryContext } from './test-helpers.js';

/**
 * Chat-load seam: onAppReady() runs the serialized ownership sync over the
 * loaded chat. Ghosting (ownership sync) is the sole owner of hidden-state
 * mutations, so hidden messages outside Summaryception ownership survive a
 * load untouched, while desired ids whose visual hide was lost are re-hidden.
 */
describe('Ghosting ownership sync across chat load', () => {
    function installLoadedChat({ chat, store }) {
        resetCommitStateForTests();
        const calls = [];
        const saves = { chat: 0, metadata: 0 };
        const runtime = installSummaryContext({
            chat,
            metadata: { summaryception: store },
            executeSlashCommandsWithOptions: async (command) => calls.push(String(command)),
            saveChat: async () => {
                saves.chat += 1;
            },
            saveMetadata: async () => {
                saves.metadata += 1;
            },
        });
        return { calls, saves, runtime };
    }

    it('leaves hidden messages outside ownership untouched during the load sync', async () => {
        const chat = [
            makeMessage({ scId: 'message-0', isHidden: true, isSystem: true }),
            makeMessage({ scId: 'message-1' }),
        ];
        const store = makeSummaryStore();
        const { calls, saves, runtime } = installLoadedChat({ chat, store });

        await onAppReady();

        expect(calls).toEqual([]);
        expect(chat[0]).toMatchObject({ is_system: true, is_hidden: true });
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([]);
        expect(saves).toEqual({ chat: 0, metadata: 0 });
    });

    it('re-issues the hide for a desired id whose hidden flag was lost', async () => {
        const chat = [
            makeMessage({ scId: 'message-0', isHidden: true }),
            makeMessage({ scId: 'message-1' }),
        ];
        const store = makeSummaryStore({
            ghostedMessageIds: ['message-0', 'message-1'],
            layers: [[{ text: 'summary', sourceMessageIds: ['message-0', 'message-1'] }]],
        });
        const { calls, runtime } = installLoadedChat({ chat, store });

        await onAppReady();

        expect(calls).toEqual(['/hide 1']);
        expect(runtime.chatMetadata.summaryception.ghostedMessageIds).toEqual([
            'message-0',
            'message-1',
        ]);
    });
});
