import { beforeEach, describe, expect, it, vi } from 'vitest';
import { installSillyTavernStub, makeMessage } from './test-helpers.js';

const baseSettings = {
    minSummaryTurns: 3,
    maxSummaryTurns: 8,
    minSummaryBudget: 8000,
    verbatimTokenBudget: 16000,
    applyRegexScripts: false,
};

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
});

async function buildPartitions(chat, turns, settings = {}) {
    installSillyTavernStub({
        chat,
        getTokenCountAsync: countMarkedTokens,
    });
    const { buildLayer0Partitions } = await import('../src/core/partition-planner.js');
    return await buildLayer0Partitions(chat, 0, turns, { ...baseSettings, ...settings });
}

function countMarkedTokens(text) {
    const match = String(text).match(/\[(\d+)]/);
    return Promise.resolve(match ? Number(match[1]) : 1);
}

function assistantTurns(chat) {
    return chat.map((message, index) => ({ index, mes: message.mes, name: message.name }));
}

describe('buildLayer0Partitions', () => {
    it('keeps a slight target overshoot as one partition', async () => {
        const chat = [makeMessage({ mes: '[8250]' })];

        const partitions = await buildPartitions(chat, assistantTurns(chat));

        expect(partitions).toHaveLength(1);
        expect(partitions[0].stats.finalTokens).toBe(8250);
        expect(partitions[0].sourceEndIdx).toBe(0);
    });

    it('splits large source ranges into balanced token partitions', async () => {
        const chat = Array.from({ length: 4 }, () => makeMessage({ mes: '[6250]' }));

        const partitions = await buildPartitions(chat, assistantTurns(chat));

        expect(partitions).toHaveLength(4);
        expect(partitions.map((partition) => partition.stats.finalTokens)).toEqual([
            6250, 6250, 6250, 6250,
        ]);
    });

    it('keeps an indivisible huge assistant turn intact', async () => {
        const chat = [makeMessage({ mes: '[12000]' }), makeMessage({ mes: '[1000]' })];

        const partitions = await buildPartitions(chat, assistantTurns(chat));

        expect(partitions.map((partition) => partition.turns.map((turn) => turn.index))).toEqual([
            [0],
            [1],
        ]);
        expect(partitions[0].stats.finalTokens).toBe(12000);
    });

    it('can include a final trailing user endpoint in the last partition', async () => {
        const chat = [
            makeMessage({ mes: '[3000]' }),
            makeMessage({ isUser: true, mes: '[2000]', name: 'Player' }),
        ];

        installSillyTavernStub({ chat, getTokenCountAsync: countMarkedTokens });
        const { buildLayer0Partitions } = await import('../src/core/partition-planner.js');
        const partitions = await buildLayer0Partitions(
            chat,
            0,
            [assistantTurns(chat)[0]],
            baseSettings,
            {
                finalSourceEndIdx: 1,
            },
        );

        expect(partitions).toHaveLength(1);
        expect(partitions[0]).toMatchObject({ sourceStartIdx: 0, sourceEndIdx: 1 });
        expect(partitions[0].stats.finalTokens).toBe(5000);
    });
});
