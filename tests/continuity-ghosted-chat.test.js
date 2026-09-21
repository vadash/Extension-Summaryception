import { describe, expect, it } from 'vitest';

import {
    deriveContinuityCoverage,
    deriveContinuityMarks,
} from '../src/core/continuity-coverage.js';
import { deriveTurnCount } from '../src/core/continuity-state.js';
import { formatContinuityBlock } from '../src/features/continuity-injection.js';
import {
    CHAT_SHAPE,
    CHECKPOINT_GAPS,
    CHECKPOINT_LEDGER,
    GHOSTED_RANGE,
    NPC_NAME,
    PAIR_KEY,
    buildGhostedChat,
} from './fixtures/ghosted-continuity-chat.js';

/**
 * A chat the Summarizer has ghosted most of still counts every Exchange
 * (ADR-0028): prompt visibility is not part of a reply's identity, so the Turn
 * Count, the coverage anchor, and the Continuity Marks all read the chat.
 */
describe('a chat whose summarized prefix is ghosted', () => {
    const chat = buildGhostedChat();

    it('reproduces the export shape', () => {
        expect(chat).toHaveLength(CHAT_SHAPE.messages);
        expect(chat.filter((message) => message.is_user)).toHaveLength(CHAT_SHAPE.userMessages);

        const ghostedIndices = chat.flatMap((message, index) => (message.is_system ? [index] : []));
        expect(ghostedIndices).toHaveLength(CHAT_SHAPE.ghostedMessages);
        expect(ghostedIndices[0]).toBe(GHOSTED_RANGE[0]);
        expect(ghostedIndices[ghostedIndices.length - 1]).toBe(GHOSTED_RANGE[1]);
    });

    it('counts every Exchange, including the ones Ghosting hid', () => {
        expect(deriveTurnCount(chat)).toBe(CHAT_SHAPE.assistantMessages);
    });

    it('anchors coverage on the newest checkpoint, hidden or not', () => {
        const coverage = deriveContinuityCoverage(chat);

        expect(coverage.checkpointIndex).toBe(118);
        expect(coverage.turnCount).toBe(CHAT_SHAPE.assistantMessages);
        expect(coverage.unauditedIndices).toEqual([120]);
        expect(coverage.targetIndex).toBe(120);
        expect(coverage.windowIndices).toEqual([119, 120]);
        expect(coverage.stale).toBe(true);
        expect(coverage.blockDepth).toBe(2);
    });

    it('marks every checkpointed reply, not only the un-ghosted ones', () => {
        const marks = deriveContinuityMarks(chat);

        expect(marks.markedIndices).toEqual(CHECKPOINT_LEDGER.map(([index]) => index));
        expect(marks.liveIndex).toBe(118);
    });

    it('keeps the sawtooth Turn Count the old predicate wrote into the payloads', () => {
        expect(chat[32].extra.summaryception_continuity.turn_count).toBe(17);
        expect(chat[36].extra.summaryception_continuity.turn_count).toBe(8);
        expect(chat[118].extra.summaryception_continuity.turn_count).toBe(14);
    });

    it('leaves the un-audited replies without a payload', () => {
        const gaps = chat.flatMap((message, index) =>
            !message.is_user && message.extra.summaryception_continuity === undefined
                ? [index]
                : [],
        );

        expect(gaps).toEqual([...CHECKPOINT_GAPS]);
    });

    it('renders the four sections from a checkpoint still carrying the retired agenda fields', () => {
        const block = formatContinuityBlock(chat[2].extra.summaryception_continuity);

        expect(block).toContain('[SCENE & POSITIONING]');
        expect(block).toContain('[RELATIONSHIP GATES]');
        expect(block).toContain('[SECRETS & ASYMMETRIC KNOWLEDGE]');
        expect(block).toContain('[ACTIVE AGENDAS & THREADS]');
        expect(block).toContain(PAIR_KEY);
        expect(block).toContain(NPC_NAME);
        expect(block).not.toContain('retired field');
    });
});
