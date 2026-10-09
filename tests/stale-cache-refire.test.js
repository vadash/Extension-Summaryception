import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// A completed Force Summarize run must leave the stale-cache advice silent.
// The verbatim cut stays inside the budget, so the drained window sits below
// the full-budget trigger line and a reload cannot re-queue whole turns
// behind the dialog.

const layer0Mocks = vi.hoisted(() => ({ runLayer0: vi.fn() }));

vi.mock('../src/core/layer0-run.js', () => layer0Mocks);
vi.mock('../src/core/summarizer-promotion.js', () => ({
    drainPromotionOverflow: vi.fn(async () => ({ status: 'completed', attempts: 0 })),
}));

import { evaluateStaleCacheAdvice } from '../src/core/cache-staleness.js';
import { runManual } from '../src/core/summarizer-engine.js';
import { buildChatWindowPlan } from '../src/core/chat-window-planner.js';
import { getChat } from '../src/foundation/context.js';
import { getChatStore } from '../src/foundation/chat-store.js';
import { getEffectiveSettings } from '../src/foundation/settings.js';
import {
    installSummaryContext,
    makeChatPersistence,
    makeForegroundGate,
    makeMessage,
} from './test-helpers.js';
import { MEMORY_MODES } from '../src/foundation/constants.js';

const NOW = Date.now();

/** Build one exchange: small user message + large assistant reply. */
function makeExchange(assistantChars, minutesAgo) {
    return [
        makeMessage({ isUser: true, mes: 'u'.repeat(100) }),
        makeMessage({
            mes: 'a'.repeat(assistantChars),
            sendDate: NOW - minutesAgo * 60_000,
        }),
    ];
}

/** An idle overnight chat: old last turn, live window well past the budget. */
function installStaleChat() {
    const chat = [];
    for (let i = 0; i < 8; i++) {
        chat.push(...makeExchange(3000, 940 - i));
    }
    installSummaryContext({
        chat,
        settings: {
            enabled: true,
            memoryMode: MEMORY_MODES.PREFIX_CACHE,
            cacheTtlMinutes: 30,
            minSummaryTurns: 3,
            verbatimTokenBudget: 16000,
            queuedTokenBudget: 6000,
        },
    });
    return chat;
}

/** Production-like commit: one Layer 0 snippet owning each batch's turns. */
function commitBatch(plan) {
    const chat = getChat();
    const store = getChatStore();
    store.layers[0] ||= [];
    for (const partition of plan.partitions.length
        ? plan.partitions
        : [{ turns: plan.batchTurns }]) {
        const ids = (partition.turns || []).map((turn) => chat[turn.index]?.sc_id).filter(Boolean);
        if (ids.length) {
            store.layers[0].push({ text: `summary of ${ids.length} turns`, sourceMessageIds: ids });
        }
    }
    return { status: 'completed' };
}

/** Advise exactly as the chat-load reconciliation does. */
async function readAdvice(now) {
    const chat = getChat();
    const settings = getEffectiveSettings();
    const plan = await buildChatWindowPlan(chat, getChatStore(), settings);
    return {
        advice: evaluateStaleCacheAdvice({ chat, plan, settings, now }),
        verbatimTokens: plan.verbatimTokens,
    };
}

describe('stale-cache advice after a Force run', () => {
    beforeEach(() => {
        makeChatPersistence();
        layer0Mocks.runLayer0.mockImplementation(async (plan) => commitBatch(plan));
    });

    afterEach(() => {
        vi.clearAllMocks();
    });

    it('does not re-advise once the force run drains the queue', async () => {
        installStaleChat();

        const before = await readAdvice(NOW);
        expect(before.advice.advise).toBe(true);
        expect(before.advice.queuedTurns).toBeGreaterThanOrEqual(3);

        const runToken = { end: vi.fn(), isStopped: vi.fn(() => false) };
        const outcome = await runManual(
            {
                queue: { setPhase: vi.fn(), beginRun: vi.fn(() => runToken) },
                refreshUi: vi.fn(),
                withUsageRun: vi.fn(async (_label, work) => await work()),
                gate: makeForegroundGate().gate,
            },
            'FORCE',
            {},
        );

        expect(outcome.status).toBe('completed');
        expect(outcome.completed).toBeGreaterThan(0);

        const after = await readAdvice(NOW);
        expect(after.advice.advise).toBe(false);
        expect(after.advice.queuedTurns).toBe(0);
        // The cut lands inside the configured budget, leaving trigger headroom.
        expect(after.verbatimTokens).toBeLessThanOrEqual(16000);
    });
});
