import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer,
    abortAllRequests: vi.fn(),
    isRequestLive: vi.fn(() => false),
}));

import { runAuditorExtraction } from '../src/core/continuity-runner.js';
import { findLiveCheckpoint, hashMessageText } from '../src/foundation/continuity.js';
import { updateContinuityInjection } from '../src/features/continuity-injection.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

// Continuity State as of exchange 1's settled audit: checkpoint on a1, one
// spark, no notes, no scene location yet.
const auditedExchangeOne = (overrides = {}) => ({
    turn_count: 1,
    bonds: { 'Quipsy↔User': { bond: 1, sparks: 1, grudge: 0 } },
    agendas: {},
    gm_notes: [],
    physics: {
        location: '',
        environment: '',
        posture_and_position: '',
        contact_points: '',
        clothing_state: '',
    },
    ...overrides,
});

const regenChat = () => [
    makeMessage({ isUser: true, scId: 'u1' }),
    makeMessage({ scId: 'a1' }),
    makeMessage({ isUser: true, scId: 'u2' }),
    makeMessage({ scId: 'a2' }),
];

const draftTwoAudit = () =>
    JSON.stringify({
        turn_count: 999,
        bonds: { 'Quipsy↔User': { positive_interaction: true } },
        agendas: {},
        gm_notes: ['[T] draft-two thread'],
        physics: {
            location: 'Kitchen',
            environment: '',
            posture_and_position: '',
            contact_points: '',
            clothing_state: '',
        },
    });

afterEach(() => {
    vi.resetModules();
    callSummarizer.mockReset();
    delete globalThis.SillyTavern;
});

describe('continuity coverage across regenerate', () => {
    it('drops the read model back to the prior checkpoint when the audited reply is deleted', async () => {
        const chat = regenChat();
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            setExtensionPrompt,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
        });
        chat[1].extra.summaryception_continuity = {
            state: auditedExchangeOne(),
            audited_sc_id: 'a1',
            text_hash: hashMessageText(chat[1].mes),
        };

        // Exchange 2's draft reply lands and is audited: the draft's thread,
        // scene location, and spark enter the state, checkpointed on a2.
        callSummarizer.mockResolvedValue({ status: 'completed', text: draftTwoAudit() });
        await runAuditorExtraction();
        const audited = chat[3].extra.summaryception_continuity;
        expect(audited.audited_sc_id).toBe('a2');
        expect(audited.state.gm_notes).toEqual(['[T] draft-two thread']);

        // Regenerate removes the audited reply. No rewind event fires: the
        // chain read model drops back to exchange 1 by itself.
        chat.splice(3, 1);

        const live = findLiveCheckpoint(chat);
        expect(live.message.sc_id).toBe('a1');
        expect(live.state.gm_notes).toEqual([]);
        expect(live.state.bonds['Quipsy↔User']).toEqual({ bond: 1, sparks: 1, grudge: 0 });
        expect(live.state.physics.location).toBe('');

        // The injected block carries the same drop-back: no deleted-draft
        // content reaches the regenerated generation's prompt.
        updateContinuityInjection();
        const block = setExtensionPrompt.mock.calls.at(-1)?.[1] ?? '';
        expect(block).not.toContain('draft-two thread');
        expect(block).not.toContain('Kitchen');
        expect(block).toContain('BOND +1');
    });
});
