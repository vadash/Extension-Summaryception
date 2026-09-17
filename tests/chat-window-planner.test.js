import { describe, expect, it } from 'vitest';

import { buildChatWindowPlan } from '../src/core/chat-window-planner.js';
import {
    makeMessage,
    makeSizedChat,
    makeSummaryStore,
    messageLineTokens,
    windowSettings,
} from './test-helpers.js';

describe('buildChatWindowPlan', () => {
    it('stays idle below Recent + Queued and is ready at equality', async () => {
        const chat = makeSizedChat(2, { userLength: 40, assistantLength: 40 });
        const total = 2 * messageLineTokens(true, 40) + 2 * messageLineTokens(false, 40);
        const idle = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: total / 2,
                queuedTokenBudget: total / 2 + 1,
            }),
        );
        const ready = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: total / 2,
                queuedTokenBudget: total / 2,
            }),
        );
        expect(idle.reason).toBe('none');
        expect(ready.reason).toBe('ready');
        expect(ready.tokenBudgetExceeded).toBe(true);
    });

    it('keeps complete messages in A and ends B on the prior assistant', async () => {
        const chat = makeSizedChat(3, { userLength: 40, assistantLength: 60 });
        const plan = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: messageLineTokens(false, 60) + 1,
                queuedTokenBudget: 1,
            }),
        );
        expect(plan.verbatimStartIdx).toBe(4);
        expect(plan.queuedEndIdx).toBe(3);
        expect(plan.eligibleTurns.map((turn) => turn.index)).toEqual([1, 3]);
    });

    it('stays idle when the latest conversation message is a user message', async () => {
        const chat = [...makeSizedChat(2), makeMessage({ isUser: true, mes: 'x'.repeat(500) })];
        const plan = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: 50,
                queuedTokenBudget: 50,
            }),
        );
        expect(plan.reason).toBe('none');
    });

    it('starts after the committed summary cursor', async () => {
        const chat = makeSizedChat(4, { userLength: 50, assistantLength: 50 });
        const store = makeSummaryStore({
            layers: [[{ text: 'old', sourceMessageIds: [chat[3].sc_id] }]],
        });
        const plan = await buildChatWindowPlan(
            chat,
            store,
            windowSettings({ verbatimTokenBudget: 100, queuedTokenBudget: 100 }),
        );
        expect(plan.sourceStartIdx).toBe(4);
        expect(plan.eligibleTurns.every((turn) => turn.index > 3)).toBe(true);
    });

    it('enforces min turns and does not trigger early from max turns', async () => {
        const chat = makeSizedChat(4, { userLength: 20, assistantLength: 20 });
        const gated = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: 20,
                queuedTokenBudget: 20,
                minSummaryTurns: 4,
            }),
        );
        const below = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: 10000,
                queuedTokenBudget: 10000,
                maxSummaryTurns: 2,
            }),
        );
        expect(gated.reason).toBe('none');
        expect(below.reason).toBe('none');
    });

    it('repairs full user-only overflow and force requires queued assistant turns', async () => {
        const users = [
            makeMessage({ isUser: true, mes: 'x'.repeat(100) }),
            makeMessage({ isUser: true, mes: 'x'.repeat(100) }),
        ];
        const repair = await buildChatWindowPlan(
            users,
            makeSummaryStore(),
            windowSettings({ verbatimTokenBudget: 50, queuedTokenBudget: 50 }),
        );
        const forceChat = makeSizedChat(2, { userLength: 10, assistantLength: 10 });
        const force = await buildChatWindowPlan(
            forceChat,
            makeSummaryStore(),
            windowSettings({ verbatimTokenBudget: 10000, queuedTokenBudget: 10000 }),
            { ignoreReadiness: true },
        );
        expect(repair.reason).toBe('repair');
        expect(force.reason).toBe('none');
        expect(force.eligibleTurns).toHaveLength(0);
    });

    it('wires the queued window into partitions covering every eligible turn', async () => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const plan = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({
                verbatimTokenBudget: 100,
                queuedTokenBudget: 500,
                minSummaryBudget: 3000,
                maxL0SourceTokens: 4000,
            }),
        );
        // Partition balancing itself is covered by partition-planner.test.js. This
        // test only proves the wider seam produces non-empty, fully covering partitions.
        expect(plan.partitions.length).toBeGreaterThan(0);
        expect(plan.partitions.flatMap((part) => part.turns)).toHaveLength(
            plan.eligibleTurns.length,
        );
    });

    it('excludes non-conversation records from recent/queued accounting', async () => {
        const chat = makeSizedChat(2, { userLength: 40, assistantLength: 40 });
        chat.splice(2, 0, makeMessage({ mes: 'x'.repeat(1000), isSystem: true }));
        const plan = await buildChatWindowPlan(
            chat,
            makeSummaryStore(),
            windowSettings({ verbatimTokenBudget: 10000, queuedTokenBudget: 10000 }),
        );
        expect(plan.liveTokens).toBe(
            2 * messageLineTokens(true, 40) + 2 * messageLineTokens(false, 40),
        );
    });
});
