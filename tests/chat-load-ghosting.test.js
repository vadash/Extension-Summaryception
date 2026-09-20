import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { onAppReady } from '../src/entry/events.js';
import { resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { initRefreshPort } from '../src/foundation/refresh.js';
import { EXTENSION_PROMPT_POSITIONS, EXTENSION_PROMPT_ROLES } from '../src/foundation/constants.js';
import { updateInjection } from '../src/features/injection.js';
import { updateContinuityInjection } from '../src/features/continuity-injection.js';
import { makeMessage, makeSummaryStore, installSummaryContext } from './test-helpers.js';

// The composition root registers the renderers into the Refresh Port; these
// tests pin the same wiring so reconcile's refreshPreview reaches them.
beforeEach(() => {
    initRefreshPort({ updateInjection, updateContinuityInjection });
});

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

describe('Continuity slot re-render across chat load', () => {
    afterEach(() => {
        resetCommitStateForTests();
    });

    function makeLoadedContinuity(overrides = {}) {
        return {
            turn_count: 1,
            bonds: { 'Quipsy↔User': { bond: 2, sparks: 0, grudge: 0 } },
            agendas: {},
            gm_notes: [],
            physics: {
                location: 'Salon',
                environment: '',
                posture_and_position: '',
                contact_points: '',
                clothing_state: '',
            },
            ...overrides,
        };
    }

    it('re-renders the continuity slot from the loaded chat checkpoint on app ready', async () => {
        const chat = [makeMessage({ scId: 'message-0' }), makeMessage({ scId: 'message-1' })];
        chat[1].extra.summaryception_continuity = makeLoadedContinuity();
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
            setExtensionPrompt,
        });
        resetCommitStateForTests();

        await onAppReady();

        const continuityCall = setExtensionPrompt.mock.calls.find(
            ([name]) => name === 'summaryception_continuity',
        );
        expect(continuityCall).toBeDefined();
        expect(continuityCall[1]).toContain('<active_continuity>');
        expect(continuityCall[1]).toContain('BOND +2');
        expect(continuityCall[2]).toBe(EXTENSION_PROMPT_POSITIONS.IN_CHAT);
        expect(continuityCall[5]).toBe(EXTENSION_PROMPT_ROLES.SYSTEM);

        const memoryCall = setExtensionPrompt.mock.calls.find(
            ([name]) => name === 'summaryception',
        );
        expect(memoryCall).toBeDefined();
    });

    it('clears the continuity slot when the loaded chat has no continuity state', async () => {
        const chat = [makeMessage({ scId: 'message-0' })];
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
            setExtensionPrompt,
        });
        resetCommitStateForTests();

        await onAppReady();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            '',
            EXTENSION_PROMPT_POSITIONS.NONE,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });
});
