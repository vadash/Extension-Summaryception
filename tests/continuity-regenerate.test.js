import { afterEach, describe, expect, it, vi } from 'vitest';

const callSummarizer = vi.hoisted(() => vi.fn());
vi.mock('../src/core/summarizer-request.js', () => ({
    callSummarizer,
    abortAllRequests: vi.fn(),
    isRequestLive: vi.fn(() => false),
}));

import { isPromptMutationFrozen, resetCommitStateForTests } from '../src/core/summarizer-commit.js';
import { runAuditorExtraction } from '../src/core/continuity-runner.js';
import {
    deriveContinuityCoverage,
    endRerollTail,
    isRerollTailInFlight,
} from '../src/core/continuity-coverage.js';
import { updateContinuityInjection } from '../src/features/continuity-injection.js';
import { onGenerationStarted } from '../src/entry/events.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

const continuityWrites = vi.hoisted(() => ({ frozenAtWrite: [] }));
vi.mock('../src/features/continuity-injection.js', async (importOriginal) => {
    const actual = await importOriginal();
    return {
        ...actual,
        updateContinuityInjection: () => {
            continuityWrites.frozenAtWrite.push(isPromptMutationFrozen());
            actual.updateContinuityInjection();
        },
    };
});

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
    continuityWrites.frozenAtWrite.length = 0;
    endRerollTail();
    resetCommitStateForTests();
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
        chat[1].extra.summaryception_continuity = auditedExchangeOne();

        // Exchange 2's draft reply lands and is audited: the draft's thread,
        // scene location, and spark enter the state, checkpointed on a2.
        callSummarizer.mockResolvedValue({ status: 'completed', text: draftTwoAudit() });
        await runAuditorExtraction();
        expect(chat[3].extra.summaryception_continuity.gm_notes).toEqual(['[T] draft-two thread']);

        // Regenerate removes the audited reply. No rewind event fires: the
        // newest-payload read model drops back to exchange 1 by itself.
        chat.splice(3, 1);

        const coverage = deriveContinuityCoverage(chat);
        expect(coverage.checkpointIndex).toBe(1);
        expect(coverage.state.gm_notes).toEqual([]);
        expect(coverage.state.bonds['Quipsy↔User']).toEqual({ bond: 1, sparks: 1, grudge: 0 });
        expect(coverage.state.physics.location).toBe('');

        // The injected block carries the same drop-back: no deleted-draft
        // content reaches the regenerated generation's prompt.
        updateContinuityInjection();
        const block = setExtensionPrompt.mock.calls.at(-1)?.[1] ?? '';
        expect(block).not.toContain('draft-two thread');
        expect(block).not.toContain('Kitchen');
        expect(block).toContain('BOND +1');
    });

    it('skips the audit when the newest reply already carries a checkpoint', async () => {
        const chat = regenChat();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
        });
        chat[1].extra.summaryception_continuity = auditedExchangeOne();
        // A regenerated reply kept its pre-regeneration payload: newest-wins
        // anchors coverage there and no unaudited exchange remains.
        chat[3].extra.summaryception_continuity = auditedExchangeOne({
            turn_count: 2,
            physics: { ...auditedExchangeOne().physics, location: 'Old Draft' },
        });

        const outcome = await runAuditorExtraction();

        expect(outcome.status).toBe('idle');
        expect(callSummarizer).not.toHaveBeenCalled();
        expect(chat[3].extra.summaryception_continuity.physics.location).toBe('Old Draft');
    });
});

describe('continuity injection across reroll', () => {
    const rerollChat = () => {
        const chat = regenChat();
        chat[1].extra.summaryception_continuity = auditedExchangeOne();
        // The live checkpoint on the reply about to be rerolled: it describes
        // the exact draft the host generation will replace.
        chat[3].extra.summaryception_continuity = auditedExchangeOne({
            turn_count: 2,
            gm_notes: ['[T] draft-two thread'],
            physics: { ...auditedExchangeOne().physics, location: 'Kitchen' },
        });
        return chat;
    };

    it('drops the rerolled reply checkpoint before the freeze so the prompt ships the prior state', () => {
        const chat = rerollChat();
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            setExtensionPrompt,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
        });

        onGenerationStarted('regenerate', {}, false);

        // The hook write must land inside the gate's pre-freeze window (the
        // write itself records the gate state); once the generation start
        // returns, the freeze is on.
        expect(continuityWrites.frozenAtWrite).toEqual([false]);
        expect(isPromptMutationFrozen()).toBe(true);

        expect(chat[3].extra.summaryception_continuity).toBeUndefined();
        expect(deriveContinuityCoverage(chat).checkpointIndex).toBe(1);

        const slotCall = setExtensionPrompt.mock.calls.find(
            ([name]) => name === 'summaryception_continuity',
        );
        expect(slotCall).toBeDefined();
        const [, block, , depth] = slotCall;
        expect(block).not.toContain('draft-two thread');
        expect(block).not.toContain('Kitchen');
        expect(block).toContain('BOND +1');
        // The host drops the rerolled reply from the prompt chat (ST
        // script.js coreChat.pop() for a swipe, and the delete for a
        // regenerate), so the block lands one message past the covered
        // exchange: directly before the pending user turn u2, not inside the
        // covered exchange.
        expect(depth).toBe(1);
    });

    it('keeps the checkpoint and the whole prompt view when regenerate answers a trailing user turn', () => {
        // ST treats regenerate on a trailing user message as "generate a new
        // reply": nothing is replaced and nothing leaves the prompt.
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
        ];
        chat[1].extra.summaryception_continuity = auditedExchangeOne();
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            setExtensionPrompt,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
        });

        onGenerationStarted('regenerate', {}, false);

        expect(chat[1].extra.summaryception_continuity).toBeDefined();
        expect(deriveContinuityCoverage(chat).checkpointIndex).toBe(1);
        expect(isRerollTailInFlight()).toBe(false);

        updateContinuityInjection();

        const slotCall = setExtensionPrompt.mock.calls.find(
            ([name]) => name === 'summaryception_continuity',
        );
        expect(slotCall[1]).toContain('BOND +1');
        expect(slotCall[3]).toBe(1);
    });

    it('drops the checkpoint on swipe generations the same way', () => {
        const chat = rerollChat();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
        });

        onGenerationStarted('swipe', {}, false);

        expect(chat[3].extra.summaryception_continuity).toBeUndefined();
        expect(deriveContinuityCoverage(chat).checkpointIndex).toBe(1);
    });

    it('keeps the checkpoint on generations that do not replace the last reply', () => {
        const chat = rerollChat();
        installSummaryContext({
            chat,
            metadata: { summaryception: makeSummaryStore() },
            settings: { continuityEnabled: true },
        });

        onGenerationStarted('normal', {}, false);

        expect(chat[3].extra.summaryception_continuity).toBeDefined();
        expect(deriveContinuityCoverage(chat).checkpointIndex).toBe(3);
    });
});
