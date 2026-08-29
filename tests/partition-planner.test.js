import { describe, expect, it } from 'vitest';

import { buildLayer0Partitions, countSourceRangeTokens } from '../src/core/partition-planner.js';
import {
    installSummaryContext,
    makeMessage,
    makeSizedChat,
    makeSummarySettings,
    messageLineTokens,
} from './test-helpers.js';

function turnsAt(chat, indices) {
    return indices.map((index) => ({
        index,
        mes: chat[index].mes,
        name: chat[index].name,
    }));
}

describe('buildLayer0Partitions', () => {
    it('returns no partitions when there are no assistant turns', async () => {
        const partitions = await buildLayer0Partitions({
            chat: makeSizedChat(2),
            sourceStartIdx: 0,
            assistantTurns: [],
            settings: makeSummarySettings(),
        });

        expect(partitions).toEqual([]);
    });

    it('filters out turns before sourceStartIdx', async () => {
        const chat = makeSizedChat(1);
        const partitions = await buildLayer0Partitions({
            chat,
            sourceStartIdx: 2,
            assistantTurns: turnsAt(chat, [1]),
            settings: makeSummarySettings(),
        });

        expect(partitions).toEqual([]);
    });

    it('keeps a single partition when the source fits the target', async () => {
        const chat = makeSizedChat(2, { userLength: 500, assistantLength: 2000 });
        const partitions = await buildLayer0Partitions({
            chat,
            sourceStartIdx: 0,
            assistantTurns: turnsAt(chat, [1, 3]),
            settings: makeSummarySettings({ minSummaryBudget: 6000, maxL0SourceTokens: 24000 }),
        });

        expect(partitions.length).toBe(1);
        expect(partitions[0].sourceStartIdx).toBe(0);
        expect(partitions[0].sourceEndIdx).toBe(3);
        expect(partitions[0].turns.length).toBe(2);
        expect(partitions[0].stats.finalTokens).toBe(
            2 * messageLineTokens(true, 500) + 2 * messageLineTokens(false, 2000),
        );
    });

    it('splits oversized sources into balanced partitions on turn boundaries', async () => {
        const chat = makeSizedChat(6, { userLength: 500, assistantLength: 2000 });
        const partitions = await buildLayer0Partitions({
            chat,
            sourceStartIdx: 0,
            assistantTurns: turnsAt(chat, [1, 3, 5, 7, 9, 11]),
            settings: makeSummarySettings({ minSummaryBudget: 6000, maxL0SourceTokens: 24000 }),
        });
        const turnTokens = messageLineTokens(true, 500) + messageLineTokens(false, 2000);

        expect(partitions.length).toBe(3);
        for (const partition of partitions) {
            expect(partition.turns.length).toBe(2);
            expect(partition.stats.finalTokens).toBe(2 * turnTokens);
            expect(partition.sourceEndIdx).toBe(partition.turns[partition.turns.length - 1].index);
        }
        expect(partitions[0].sourceStartIdx).toBe(0);
        expect(partitions[0].sourceEndIdx).toBe(3);
        expect(partitions[1].sourceStartIdx).toBe(4);
        expect(partitions[1].sourceEndIdx).toBe(7);
        expect(partitions[2].sourceStartIdx).toBe(8);
        expect(partitions[2].sourceEndIdx).toBe(11);
        expect(partitions[1].sourceStartIdx).toBe(partitions[0].sourceEndIdx + 1);
        expect(partitions[2].sourceStartIdx).toBe(partitions[1].sourceEndIdx + 1);
    });

    it('gives an oversized single turn its own partition beyond the cap', async () => {
        const chat = [
            makeMessage({ isUser: true, mes: 'x'.repeat(500) }),
            makeMessage({ mes: 'x'.repeat(30000) }),
            makeMessage({ isUser: true, mes: 'x'.repeat(500) }),
            makeMessage({ mes: 'x'.repeat(2000) }),
            makeMessage({ isUser: true, mes: 'x'.repeat(500) }),
            makeMessage({ mes: 'x'.repeat(2000) }),
        ];
        const maxL0SourceTokens = 8000;
        const partitions = await buildLayer0Partitions({
            chat,
            sourceStartIdx: 0,
            assistantTurns: turnsAt(chat, [1, 3, 5]),
            settings: makeSummarySettings({ minSummaryBudget: 6000, maxL0SourceTokens }),
        });

        expect(partitions.length).toBe(2);
        expect(partitions[0].turns.length).toBe(1);
        expect(partitions[0].stats.finalTokens).toBeGreaterThan(maxL0SourceTokens);
        expect(partitions[1].turns.length).toBe(2);
        expect(partitions[1].stats.finalTokens).toBeLessThanOrEqual(
            Math.ceil(maxL0SourceTokens * 1.15),
        );
    });

    it('extends the final segment to finalSourceEndIdx', async () => {
        const chat = [
            ...makeSizedChat(2, { userLength: 500, assistantLength: 2000 }),
            makeMessage({ isUser: true, mes: 'x'.repeat(500) }),
        ];
        const partitions = await buildLayer0Partitions({
            chat,
            sourceStartIdx: 0,
            assistantTurns: turnsAt(chat, [1, 3]),
            settings: makeSummarySettings({ minSummaryBudget: 6000, maxL0SourceTokens: 24000 }),
            finalSourceEndIdx: 4,
        });

        expect(partitions.length).toBe(1);
        expect(partitions[0].sourceEndIdx).toBe(4);
        expect(partitions[0].stats.finalTokens).toBe(
            2 * messageLineTokens(true, 500) +
                2 * messageLineTokens(false, 2000) +
                messageLineTokens(true, 500),
        );
    });
});

describe('countSourceRangeTokens', () => {
    it('counts only visible conversation messages', async () => {
        const chat = [
            makeMessage({ mes: 'x'.repeat(100) }),
            makeMessage({ mes: 'x'.repeat(100), isHidden: true }),
            makeMessage({ mes: 'x'.repeat(100), isSystem: true }),
            { ...makeMessage({ mes: 'x'.repeat(100) }), extra: { type: 'tool' } },
        ];
        installSummaryContext({ chat });

        const stats = await countSourceRangeTokens(chat, 0, 3, makeSummarySettings());

        expect(stats.finalTokens).toBe(messageLineTokens(false, 100));
    });
});
