import { describe, expect, it, vi } from 'vitest';

import { createContinuityAuditor } from '../src/core/continuity-audit.js';
import { AUDITOR_DISABLED } from '../src/foundation/auditor-switch.js';
import { EXTENSION_PROMPT_POSITIONS, EXTENSION_PROMPT_ROLES } from '../src/foundation/constants.js';
import { updateContinuityInjection } from '../src/features/continuity-injection.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

/**
 * The temporary Auditor guard: the switch defaults on, the run entry returns
 * an idle Run Outcome without dispatching, and the Continuity Block injection
 * writes the empty string. Flipping AUDITOR_DISABLED restores the lifecycle
 * covered by continuity-audit and continuity-injection.
 */

const chat = () => [
    makeMessage({ isUser: true, scId: 'u1' }),
    makeMessage({ scId: 'a1' }),
    makeMessage({ isUser: true, scId: 'u2' }),
    makeMessage({ scId: 'a2' }),
    makeMessage({ isUser: true, scId: 'u3' }),
    makeMessage({ scId: 'a3' }),
];

function makeAuditor(messages, dispatch) {
    return createContinuityAuditor({
        dispatch,
        saveChatStore: async () => {},
        refreshPreview: () => {},
        getChat: () => messages,
    });
}

describe('temporary auditor guard', () => {
    it('defaults the kill switch on', () => {
        expect(AUDITOR_DISABLED).toBe(true);
    });

    it('returns idle from the run entry without dispatching a model call', async () => {
        const messages = chat();
        const dispatch = vi.fn();
        const auditor = makeAuditor(messages, dispatch);

        const outcome = await auditor.audit({
            chat: messages,
            store: makeSummaryStore(),
            settings: { enabled: true, continuityEnabled: true },
            hasGroup: false,
            playerName: 'Player1',
        });

        expect(outcome).toEqual({ status: 'idle' });
        expect(dispatch).not.toHaveBeenCalled();
    });

    it('writes the empty string through the injection slot', () => {
        const messages = chat();
        messages[3].extra.summaryception_continuity = {
            turn_count: 2,
            bonds: {},
            agendas: {},
            gm_notes: [],
            physics: {
                location: 'Kitchen',
                environment: '',
                posture_and_position: '',
                contact_points: '',
                clothing_state: '',
            },
        };
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat: messages,
            settings: { continuityEnabled: true },
            metadata: { summaryception: makeSummaryStore() },
            setExtensionPrompt,
        });

        updateContinuityInjection();

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
