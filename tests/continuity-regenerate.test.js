import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer,
    abortAllRequests: vi.fn(),
    isRequestLive: vi.fn(() => false),
}));

import { runAuditorExtraction } from '../src/core/continuity-runner.js';
import { onChatChanged } from '../src/entry/events.js';
import { updateContinuityInjection } from '../src/features/continuity-injection.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

// Continuity State as of exchange 1's settled audit: anchor at a1, one spark,
// no notes, no scene location yet.
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
    anchor_sc_id: 'a1',
    stale: false,
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

const flushReconciliation = () => new Promise((resolve) => setTimeout(resolve, 150));

afterEach(() => {
    vi.resetModules();
    callSummarizer.mockReset();
    delete globalThis.SillyTavern;
});

describe('continuity coverage across regenerate', () => {
    it('rewinds coverage when a regenerate deletes the audited reply', async () => {
        const chat = regenChat();
        const setExtensionPrompt = vi.fn();
        const ctx = installSummaryContext({
            chat,
            setExtensionPrompt,
            metadata: {
                summaryception: makeSummaryStore({ continuity: auditedExchangeOne() }),
            },
            settings: { continuityEnabled: true },
        });

        // Exchange 2's draft reply lands and is audited: the draft's thread,
        // scene location, and spark enter the state, anchored at a2.
        callSummarizer.mockResolvedValue({ status: 'completed', text: draftTwoAudit() });
        await runAuditorExtraction();
        const audited = ctx.chatMetadata.summaryception.continuity;
        expect(audited.anchor_sc_id).toBe('a2');
        expect(audited.gm_notes).toEqual(['[T] draft-two thread']);

        // Regenerate removes the audited reply; the host fires CHAT_CHANGED.
        chat.splice(3, 1);
        onChatChanged();
        await flushReconciliation();

        // Coverage rewinds to exchange 1: the deleted draft's audit
        // contribution leaves the state ("turn 8 continuity only").
        const continuity = ctx.chatMetadata.summaryception.continuity;
        expect(continuity.anchor_sc_id).toBe('a1');
        expect(continuity.gm_notes).toEqual([]);
        expect(continuity.bonds['Quipsy↔User']).toEqual({ bond: 1, sparks: 1, grudge: 0 });
        expect(continuity.physics.location).toBe('');

        // The injected block carries the same rewind: no deleted-draft content
        // reaches the regenerated generation's prompt.
        updateContinuityInjection();
        const block = setExtensionPrompt.mock.calls.at(-1)?.[1] ?? '';
        expect(block).not.toContain('draft-two thread');
        expect(block).not.toContain('Kitchen');
    });
});
