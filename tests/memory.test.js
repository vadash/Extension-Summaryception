import { describe, expect, it, vi } from 'vitest';

import { importSummaryceptionMemory } from '../src/features/memory.js';
import {
    installSummaryContext,
    makeForegroundGate,
    makeNotifyRecorder,
    makeSummaryStore,
} from './test-helpers.js';

const gate = makeForegroundGate().gate;

describe('importSummaryceptionMemory', () => {
    const validLayers = [
        [{ text: 'l0', sourceMessageIds: ['a-1'] }],
        [
            { text: 'l1a', sourceMessageIds: ['b-1'] },
            { text: 'l1b', sourceMessageIds: ['b-2'] },
        ],
    ];

    function installStore(storeOverrides = {}) {
        const store = makeSummaryStore(storeOverrides);
        installSummaryContext({
            metadata: { summaryception: store, unrelated: { keep: true } },
        });
        return store;
    }

    it('imports valid layers through the commit seam and reports the snippet count', async () => {
        const store = installStore();
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory(
            { layers: validLayers, ghostedMessageIds: ['a-1'] },
            { notify, gate },
        );

        expect(result).toEqual({ status: 'imported', count: 3 });
        expect(store.layers).toEqual(validLayers);
        expect(store.mutationEpoch).toBeGreaterThan(0);
        expect(store.ghostedMessageIds).toEqual(['a-1', 'b-1', 'b-2']);
    });

    it('rejects a payload without layer arrays and leaves the store untouched', async () => {
        const sentinel = [{ text: 'keep', sourceMessageIds: ['keep-1'] }];
        const store = installStore({ layers: [sentinel], ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory(
            { ghostedMessageIds: [] },
            { notify, gate },
        );

        expect(result).toEqual({ status: 'invalid' });
        expect(store.layers).toEqual([sentinel]);
        expect(store.mutationEpoch).toBe(0);
    });

    it('rejects a payload without ghosted IDs and leaves the store untouched', async () => {
        const sentinel = [{ text: 'keep', sourceMessageIds: ['keep-1'] }];
        const store = installStore({ layers: [sentinel], ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory({ layers: validLayers }, { notify, gate });

        expect(result).toEqual({ status: 'invalid' });
        expect(store.layers).toEqual([sentinel]);
        expect(store.mutationEpoch).toBe(0);
    });

    it('rejects a payload whose snippets fail validation and leaves the store untouched', async () => {
        const sentinel = [{ text: 'keep', sourceMessageIds: ['keep-1'] }];
        const store = installStore({ layers: [sentinel], ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();

        const result = await importSummaryceptionMemory(
            { layers: [[{ text: 'no provenance' }]], ghostedMessageIds: [] },
            { notify, gate },
        );

        expect(result).toEqual({ status: 'invalid' });
        expect(store.layers).toEqual([sentinel]);
        expect(store.mutationEpoch).toBe(0);
    });

    it('reports failure and rolls the store back when the commit fails', async () => {
        const snapshot = [[{ text: 'keep', sourceMessageIds: ['keep-1'] }]];
        const store = installStore({ layers: snapshot, ghostedMessageIds: ['keep-1'] });
        const notify = makeNotifyRecorder();
        const failure = new Error('disk full');
        const saveMetadata = vi.fn().mockRejectedValueOnce(failure);
        installSummaryContext({ metadata: { summaryception: store }, saveMetadata });

        const result = await importSummaryceptionMemory(
            { layers: validLayers, ghostedMessageIds: ['a-1'] },
            { notify, gate },
        );

        expect(result).toEqual({ status: 'failed', cause: failure });
        expect(store.layers).toEqual(snapshot);
        expect(store.ghostedMessageIds).toEqual(['keep-1']);
        expect(store.mutationEpoch).toBe(0);
    });
});
