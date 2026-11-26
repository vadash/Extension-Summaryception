import { describe, expect, it, vi } from 'vitest';

import { buildChatWindowPlan } from '../src/core/chat-window-planner.js';
import { buildMicroficheRawSlice } from '../src/core/microfiche-raw-slice.js';
import { countSourceRangeTokens } from '../src/core/partition-planner.js';
import {
    buildForceSummaryRoutePlan,
    buildSlopSummaryRoutePlan,
} from '../src/core/summarization-routes.js';
import { runLayer0 } from '../src/core/layer0-run.js';
import { syncGhosting } from '../src/core/ghosting.js';
import { deleteSnippetAt } from '../src/features/snippet-manager.js';
import { buildPassageFromRangeWithStats, getAssistantTurns } from '../src/core/chatutils.js';
import {
    installSummaryContext,
    makeForegroundGate,
    makeMessage,
    makeSummarySettings,
    makeSummaryStore,
    messageLineTokens,
} from './test-helpers.js';

const VALID_SUMMARY =
    '<narrative>\nA concise summary.\n</narrative>\n\ncurrent_date_time: 2024-07-04 16 Thu';

function preserved(id, overrides = {}) {
    return { id, text: `Approved ${id}`, handedOff: false, ...overrides };
}

function workedChat() {
    return [
        makeMessage({ isUser: true, scId: 'm0', mes: 'zero' }),
        makeMessage({ scId: 'm1', mes: 'one' }),
        makeMessage({ isUser: true, scId: 'm2', mes: 'ANCHOR exact body' }),
        makeMessage({ isUser: true, scId: 'm3', mes: 'three' }),
        makeMessage({ scId: 'm4', mes: 'four' }),
        makeMessage({ isUser: true, scId: 'm5', mes: 'five' }),
        makeMessage({ scId: 'm6', mes: 'six' }),
        makeMessage({ isUser: true, scId: 'm7', mes: 'recent tail' }),
    ];
}

function forceSettings() {
    return makeSummarySettings({
        verbatimTokenBudget: 1,
        queuedTokenBudget: 1,
        minSummaryTurns: 10,
        minSummaryBudget: 100000,
        maxL0SourceTokens: 100000,
        maxSummaryTurns: 20,
    });
}

describe('Preserved Message exclusion and segmentation', () => {
    it('excludes preserved users and assistants from every source read model', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u0', mes: 'eligible user' }),
            makeMessage({ scId: 'a1', mes: 'eligible assistant' }),
            makeMessage({ isUser: true, scId: 'u2', mes: 'PRESERVED USER' }),
            makeMessage({ scId: 'a3', mes: 'PRESERVED ASSISTANT' }),
            makeMessage({ scId: 'a4', mes: 'later assistant' }),
        ];
        const store = makeSummaryStore({
            preservedMessages: [preserved('u2'), preserved('a3')],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });

        const passage = await buildPassageFromRangeWithStats(chat, 0, 4);
        const stats = await countSourceRangeTokens(chat, 0, 4, {
            settings: makeSummarySettings(),
        });

        expect(getAssistantTurns(chat).map((turn) => turn.index)).toEqual([1, 4]);
        expect(passage.text).not.toContain('PRESERVED');
        expect(stats.finalTokens).toBe(
            messageLineTokens(true, 'eligible user'.length) +
                messageLineTokens(false, 'eligible assistant'.length) +
                messageLineTokens(false, 'later assistant'.length),
        );
        expect(
            buildMicroficheRawSlice(chat, store, makeSummarySettings()).join('\n'),
        ).not.toContain('PRESERVED');
    });

    it('splits interleaved preserved users into contiguous oldest-first partitions', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u0', mes: 'first user' }),
            makeMessage({ scId: 'a1', mes: 'first assistant' }),
            makeMessage({ isUser: true, scId: 'u2', mes: 'preserved user' }),
            makeMessage({ scId: 'a3', mes: 'second assistant' }),
            makeMessage({ isUser: true, scId: 'u4', mes: 'recent user' }),
        ];
        const store = makeSummaryStore({ preservedMessages: [preserved('u2')] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const settings = forceSettings();

        const plan = await buildChatWindowPlan(chat, store, settings, { ignoreReadiness: true });

        expect(plan.partitions.map((part) => [part.sourceStartIdx, part.sourceEndIdx])).toEqual([
            [0, 1],
            [3, 3],
        ]);
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([1]);
    });

    it('waives only min turns for a closed segment while retaining token and latest-assistant gates', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u0', mes: 'x'.repeat(100) }),
            makeMessage({ scId: 'a1', mes: 'x'.repeat(100) }),
            makeMessage({ isUser: true, scId: 'u2', mes: 'x'.repeat(100) }),
            makeMessage({ scId: 'a3', mes: 'x'.repeat(100) }),
            makeMessage({ isUser: true, scId: 'u4', mes: 'x'.repeat(10000) }),
            makeMessage({ isUser: true, scId: 'u5', mes: 'x'.repeat(100) }),
            makeMessage({ scId: 'a6', mes: 'x'.repeat(100) }),
        ];
        const store = makeSummaryStore({ preservedMessages: [preserved('u4')] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const recentTokens = messageLineTokens(true, 100) + messageLineTokens(false, 100);
        const settings = makeSummarySettings({
            verbatimTokenBudget: recentTokens,
            queuedTokenBudget: 1,
            minSummaryTurns: 5,
        });

        const plan = await buildChatWindowPlan(chat, store, settings);

        expect(plan.reason).toBe('ready');
        expect(plan.batchTurns.map((turn) => turn.index)).toEqual([1, 3]);
        expect(plan.partitions[0].sourceEndIdx).toBe(3);
        expect(plan.liveTokens).toBe(3 * recentTokens);
    });

    it('keeps Force below the automatic trigger and excludes preserved backlog', async () => {
        const chat = workedChat();
        const store = makeSummaryStore({ preservedMessages: [preserved('m2')] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const settings = makeSummarySettings({
            verbatimTokenBudget: 20,
            queuedTokenBudget: 100000,
            minSummaryTurns: 10,
        });

        const automatic = await buildChatWindowPlan(chat, store, settings);
        const force = await buildForceSummaryRoutePlan(chat, store, settings);

        expect(automatic.reason).toBe('none');
        expect(force.reason).toBe('force');
        expect(force.ready).toBe(true);
        expect(force.overflowCount).toBe(3);
        expect(force.batchTurns.map((turn) => turn.index)).toEqual([1]);
    });

    it('does not waive min turns for an open segment after a preserved barrier', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u0', mes: 'x'.repeat(100) }),
            makeMessage({ isUser: true, scId: 'u1', mes: 'preserved' }),
            makeMessage({ isUser: true, scId: 'u2', mes: 'x'.repeat(100) }),
            makeMessage({ scId: 'a3', mes: 'x'.repeat(100) }),
            makeMessage({ isUser: true, scId: 'u4', mes: 'x'.repeat(100) }),
            makeMessage({ scId: 'a5', mes: 'x'.repeat(100) }),
        ];
        const store = makeSummaryStore({ preservedMessages: [preserved('u1')] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const recentTokens = messageLineTokens(true, 100) + messageLineTokens(false, 100);

        const plan = await buildChatWindowPlan(
            chat,
            store,
            makeSummarySettings({
                verbatimTokenBudget: recentTokens,
                queuedTokenBudget: 1,
                minSummaryTurns: 5,
            }),
        );

        expect(plan.reason).toBe('none');
    });

    it('summarizes the first assistant segment when a preserved side has no turn', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u0', mes: 'user only' }),
            makeMessage({ isUser: true, scId: 'u1', mes: 'PRESERVED' }),
            makeMessage({ isUser: true, scId: 'u2', mes: 'next user' }),
            makeMessage({ scId: 'a3', mes: 'next assistant' }),
            makeMessage({ isUser: true, scId: 'u4', mes: 'recent' }),
        ];
        const store = makeSummaryStore({ preservedMessages: [preserved('u1')] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const plan = await buildForceSummaryRoutePlan(chat, store, forceSettings());
        const dispatch = vi.fn(async () => ({ status: 'completed', text: VALID_SUMMARY }));

        await expect(
            runLayer0(plan, { gate: makeForegroundGate().gate, dispatch }),
        ).resolves.toEqual({ status: 'completed', completed: 1 });

        expect(plan.sourceStartIdx).toBe(2);
        expect(store.layers[0][0].sourceMessageIds).toEqual(['u2', 'a3']);
        expect(dispatch.mock.calls[0][0].storyTxt).not.toContain('PRESERVED');
    });

    it('prunes deleted sources during reconciliation and bumps the Mutation Epoch', async () => {
        const chat = [makeMessage({ scId: 'live', mes: 'live' })];
        const store = makeSummaryStore({
            preservedMessages: [preserved('live'), preserved('deleted')],
            mutationEpoch: 4,
        });
        const saveMetadata = vi.fn(async () => {});
        installSummaryContext({
            chat,
            metadata: { summaryception: store },
            saveMetadata,
        });

        await syncGhosting({ gate: makeForegroundGate().gate });

        expect(store.preservedMessages).toEqual([preserved('live')]);
        expect(store.mutationEpoch).toBe(5);
        expect(saveMetadata).toHaveBeenCalled();
    });
});

describe('Preserved Message Layer 0 handoff', () => {
    it('lets Slop process closed below-trigger segments oldest-first', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'm0', mes: 'zero' }),
            makeMessage({ scId: 'm1', mes: 'one' }),
            makeMessage({ isUser: true, scId: 'm2', mes: 'PRESERVED' }),
            makeMessage({ isUser: true, scId: 'm3', mes: 'three' }),
            makeMessage({ scId: 'm4', mes: 'four' }),
            makeMessage({ isUser: true, scId: 'm5', mes: 'five' }),
            makeMessage({ scId: 'm6', mes: 'six' }),
        ];
        const store = makeSummaryStore({ preservedMessages: [preserved('m2')] });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        const gate = makeForegroundGate().gate;
        const dispatch = vi.fn(async () => ({ status: 'completed', text: VALID_SUMMARY }));
        const settings = makeSummarySettings({
            verbatimTokenBudget: 100000,
            queuedTokenBudget: 100000,
            minSummaryTurns: 10,
        });

        const first = await buildSlopSummaryRoutePlan(chat, store, settings);
        expect(first.batchTurns.map((turn) => turn.index)).toEqual([1]);
        expect(first.sourceEndIdx).toBe(1);
        await expect(runLayer0(first, { gate, dispatch })).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });
        expect(store.preservedMessages[0].handedOff).toBe(false);

        const second = await buildSlopSummaryRoutePlan(chat, store, settings, { targetIndex: 6 });
        expect(second.sourceStartIdx).toBe(3);
        expect(second.batchTurns.map((turn) => turn.index)).toEqual([4, 6]);
        await expect(runLayer0(second, { gate, dispatch })).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });

        expect(store.layers[0].map((snippet) => snippet.sourceMessageIds)).toEqual([
            ['m0', 'm1'],
            ['m3', 'm4', 'm5', 'm6'],
        ]);
        expect(store.preservedMessages[0].handedOff).toBe(true);
        expect(
            dispatch.mock.calls.every(([request]) => !request.storyTxt.includes('PRESERVED')),
        ).toBe(true);
    });

    it('commits the worked example as two snippets and latches handoff only after the later commit', async () => {
        const chat = workedChat();
        const store = makeSummaryStore({ preservedMessages: [preserved('m2')] });
        const commands = [];
        installSummaryContext({
            chat,
            metadata: { summaryception: store },
            executeSlashCommandsWithOptions: async (command) => commands.push(String(command)),
        });
        const gate = makeForegroundGate().gate;
        const dispatch = vi.fn(async () => ({ status: 'completed', text: VALID_SUMMARY }));
        const settings = forceSettings();

        const firstPlan = await buildForceSummaryRoutePlan(chat, store, settings);
        await expect(runLayer0(firstPlan, { gate, dispatch })).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });

        expect(store.layers[0]).toHaveLength(1);
        expect(store.layers[0][0].sourceMessageIds).toEqual(['m0', 'm1']);
        expect(dispatch.mock.calls[0][0].storyTxt).not.toContain('ANCHOR exact body');
        expect(store.preservedMessages[0].handedOff).toBe(false);
        expect(commands).not.toContain('/hide 2');

        const secondPlan = await buildForceSummaryRoutePlan(chat, store, settings);
        await expect(runLayer0(secondPlan, { gate, dispatch })).resolves.toEqual({
            status: 'completed',
            completed: 1,
        });

        expect(store.layers[0]).toHaveLength(2);
        expect(store.layers[0][1].sourceMessageIds).toEqual(['m3', 'm4', 'm5', 'm6']);
        expect(dispatch.mock.calls[1][0].storyTxt).not.toContain('ANCHOR exact body');
        expect(store.preservedMessages[0].handedOff).toBe(true);
        expect(store.ghostedMessageIds).toContain('m2');
        expect(commands).toContain('/hide 0-6');
        expect(store.layers.flat().some((snippet) => snippet.sourceMessageIds.includes('m2'))).toBe(
            false,
        );

        await deleteSnippetAt(0, 1, { gate });

        expect(store.preservedMessages[0].handedOff).toBe(true);
        expect(store.ghostedMessageIds).toContain('m2');
        expect(commands).not.toContain('/unhide 2');
    });
});
