import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    isRegenerationCandidate,
    regenerateSnippetAt,
    updateSnippetTextAt,
} from '../src/features/snippet-manager.js';
import { resolveCallProfile } from '../src/core/call-profile.js';
import {
    installSummaryContext,
    makeForegroundGate,
    makeMessage,
    makeSummarySettings,
    makeSummaryStore,
    makeUsageLedger,
} from './test-helpers.js';

const usageLedger = await makeUsageLedger();

const gate = makeForegroundGate().gate;
const queue = {
    isBusy: vi.fn(() => false),
    beginRun: vi.fn(() => ({ end: vi.fn(), isStopped: vi.fn(() => false) })),
};
/** The dispatch stand-in; returns the outcome the real request layer would. */
const dispatch = vi.fn();

/**
 * Completed regeneration outcome carrying the profile the real request layer
 * resolves from the dispatch metadata snippet-manager builds.
 */
function completedRegeneration(text) {
    return async ({ metadata }) => ({
        status: 'completed',
        text,
        profile: resolveCallProfile(makeSummarySettings(), metadata),
    });
}

/**
 * @returns {{ store: object, snippet: object }}
 */
function installReadySnippet() {
    const chat = [
        makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
        makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
    ];
    const snippet = {
        text: 'old summary',
        sourceMessageIds: ['user-id', 'assistant-id'],
        timestamp: 0,
    };
    const store = makeSummaryStore({ layers: [[snippet]] });
    installSummaryContext({ chat, metadata: { summaryception: store } });
    return { store, snippet };
}

describe('updateSnippetTextAt', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        dispatch.mockReset();
    });

    it('returns the updated status after an applied edit', async () => {
        installReadySnippet();

        await expect(updateSnippetTextAt(0, 0, 'new text', { gate })).resolves.toEqual({
            status: 'updated',
        });
    });
});

describe('isRegenerationCandidate', () => {
    it('is true for a contiguous Layer 0 source range', () => {
        installReadySnippet();
        expect(isRegenerationCandidate(0, 0, queue)).toBe(true);
    });

    it('is false for a deeper-layer snippet', () => {
        installReadySnippet();
        expect(isRegenerationCandidate(1, 0, queue)).toBe(false);
    });

    it('is false for a missing snippet', () => {
        installReadySnippet();
        expect(isRegenerationCandidate(0, 5, queue)).toBe(false);
    });

    it('is false for non-contiguous source ids', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', mes: 'User scene.' }),
            makeMessage({ scId: 'gap-id', mes: 'Gap scene.' }),
            makeMessage({ scId: 'assistant-id', mes: 'Assistant scene.' }),
        ];
        const store = makeSummaryStore({
            layers: [[{ text: 'summary', sourceMessageIds: ['user-id', 'assistant-id'] }]],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        expect(isRegenerationCandidate(0, 0, queue)).toBe(false);
    });
});

describe('snippet regeneration request outcomes', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        dispatch.mockReset();
    });

    it('writes the regenerated snippet when the outcome is completed', async () => {
        const { store, snippet } = installReadySnippet();
        dispatch.mockImplementation(
            completedRegeneration(
                '<narrative>\nA fresh summary.\n</narrative>\n\ncurrent_date_time: 2024-07-04 16 Thu',
            ),
        );

        await expect(
            regenerateSnippetAt(0, 0, { gate, queue, dispatch, withRun: usageLedger.withRun }),
        ).resolves.toEqual({
            status: 'regenerated',
            range: [0, 1],
        });

        expect(snippet.text).toContain('A fresh summary.');
        expect(snippet.regenerated).toBe(true);
        // Ghost step acquires snippet ownership (bump) + the Snippet Commit's own bump.
        expect(store.mutationEpoch).toBe(2);
    });

    it('returns aborted without mutating the store when the outcome is aborted', async () => {
        const { store, snippet } = installReadySnippet();
        dispatch.mockResolvedValue({ status: 'aborted' });

        await expect(
            regenerateSnippetAt(0, 0, { gate, queue, dispatch, withRun: usageLedger.withRun }),
        ).resolves.toEqual({
            status: 'aborted',
        });

        expect(snippet.text).toBe('old summary');
        expect(store.mutationEpoch).toBe(0);
    });

    it('returns blocked without mutating the store when the outcome is blocked', async () => {
        const { store, snippet } = installReadySnippet();
        dispatch.mockResolvedValue({ status: 'blocked' });

        await expect(
            regenerateSnippetAt(0, 0, { gate, queue, dispatch, withRun: usageLedger.withRun }),
        ).resolves.toEqual({
            status: 'blocked',
        });

        expect(snippet.text).toBe('old summary');
        expect(store.mutationEpoch).toBe(0);
    });

    it('regenerates a fully ghosted Layer 0 range from its owned source turns', async () => {
        const chat = [
            makeMessage({
                isUser: true,
                scId: 'user-id',
                isSystem: true,
                isHidden: true,
                mes: 'User scene.',
            }),
            makeMessage({
                scId: 'assistant-id',
                isSystem: true,
                isHidden: true,
                mes: 'Assistant scene.',
            }),
        ];
        const snippet = {
            text: 'old summary',
            sourceMessageIds: ['user-id', 'assistant-id'],
            timestamp: 0,
        };
        const store = makeSummaryStore({
            layers: [[snippet]],
            ghostedMessageIds: ['user-id', 'assistant-id'],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });
        dispatch.mockImplementation(completedRegeneration('A fresh summary.'));

        await expect(
            regenerateSnippetAt(0, 0, { gate, queue, dispatch, withRun: usageLedger.withRun }),
        ).resolves.toEqual({
            status: 'regenerated',
            range: [0, 1],
        });
        expect(snippet.text).toContain('A fresh summary.');
    });

    it('still reports empty-source when a user-hidden range has no live ownership', async () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'user-id', isHidden: true, mes: 'User scene.' }),
            makeMessage({ scId: 'assistant-id', isHidden: true, mes: 'Assistant scene.' }),
        ];
        const store = makeSummaryStore({
            layers: [[{ text: 'summary', sourceMessageIds: ['user-id', 'assistant-id'] }]],
        });
        installSummaryContext({ chat, metadata: { summaryception: store } });

        await expect(
            regenerateSnippetAt(0, 0, { gate, queue, dispatch, withRun: usageLedger.withRun }),
        ).resolves.toEqual({
            status: 'empty-source',
        });
        expect(dispatch).not.toHaveBeenCalled();
    });
});
