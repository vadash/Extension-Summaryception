import { describe, expect, it, vi } from 'vitest';

import { MEMORY_MODES, NOTIFY_EVENTS } from '../src/foundation/constants.js';
import {
    MICROFICHE_READER_CAPABILITY,
    checkMicroficheReadiness,
    gateMicroficheMode,
    isMicroficheMode,
    resolveMicroficheReaders,
} from '../src/core/microfiche-gate.js';
import { runElasticAutoCycle } from '../src/core/summarizer-engine.js';
import {
    SUMMARY_COMMIT_MODES,
    SUMMARY_ROUTES,
    buildAutoSummaryRoutePlan,
} from '../src/core/summarization-routes.js';
import {
    installSummaryContext,
    makeForegroundGate,
    makeNotifyRecorder,
    makeSizedChat,
    makeSummaryStore,
    readySettings,
} from './test-helpers.js';

describe('microfiche gate pure checks', () => {
    it('documents the image-inline host capability', () => {
        expect(MICROFICHE_READER_CAPABILITY).toBe('image-inline');
    });

    it('ignores non-microfiche modes as ready', () => {
        expect(
            checkMicroficheReadiness({ settings: { memoryMode: 'balanced' }, host: {} }),
        ).toEqual({ ok: true });
        expect(checkMicroficheReadiness({})).toEqual({ ok: true });
        expect(isMicroficheMode({ memoryMode: 'balanced' })).toBe(false);
        expect(isMicroficheMode({ memoryMode: 'microfiche' })).toBe(true);
        expect(isMicroficheMode(null)).toBe(false);
    });

    it('resolves curated readers per geometry', () => {
        expect(
            resolveMicroficheReaders({ memoryMode: 'microfiche', microficheGeometry: 'google' }),
        ).toEqual(['google']);
        expect(resolveMicroficheReaders({ memoryMode: 'microfiche' })).toEqual([]);
        expect(
            resolveMicroficheReaders({ memoryMode: 'balanced', microficheGeometry: 'google' }),
        ).toEqual([]);
        expect(
            resolveMicroficheReaders({ memoryMode: 'microfiche', microficheGeometry: 'custom' }),
        ).toEqual([]);
    });

    it('reports no-readers for custom geometry even with a capable host', () => {
        expect(
            checkMicroficheReadiness({
                settings: { memoryMode: 'microfiche', microficheGeometry: 'custom' },
                host: { canInlineImages: true },
            }),
        ).toEqual({ ok: false, reason: 'no-readers' });
    });

    it('reports no-vision when the host cannot inline images', () => {
        expect(
            checkMicroficheReadiness({
                settings: { memoryMode: 'microfiche', microficheGeometry: 'google' },
                host: { canInlineImages: false },
            }),
        ).toEqual({ ok: false, reason: 'no-vision' });
        expect(
            checkMicroficheReadiness({
                settings: { memoryMode: 'microfiche', microficheGeometry: 'google' },
            }),
        ).toEqual({ ok: false, reason: 'no-vision' });
    });

    it('passes a curated geometry with a capable host', () => {
        expect(
            checkMicroficheReadiness({
                settings: { memoryMode: 'microfiche', microficheGeometry: 'google' },
                host: { canInlineImages: true },
            }),
        ).toEqual({ ok: true });
    });

    it('emits the geometry red kind for no-readers', () => {
        const recorder = makeNotifyRecorder();
        const settings = { memoryMode: 'microfiche', microficheGeometry: 'custom' };
        const result = gateMicroficheMode({
            settings,
            host: { canInlineImages: true },
            notify: recorder,
        });
        expect(result).toEqual({ ok: false, reason: 'no-readers' });
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0]).toMatchObject({
            type: 'transient',
            kind: NOTIFY_EVENTS.MICROFICHE_GEOMETRY_BLOCKED,
        });
    });

    it('emits the reader red kind for no-vision', () => {
        const recorder = makeNotifyRecorder();
        const settings = { memoryMode: 'microfiche', microficheGeometry: 'google' };
        const result = gateMicroficheMode({ settings, host: {}, notify: recorder });
        expect(result).toEqual({ ok: false, reason: 'no-vision' });
        expect(recorder.events).toHaveLength(1);
        expect(recorder.events[0]).toMatchObject({
            type: 'transient',
            kind: NOTIFY_EVENTS.MICROFICHE_READER_BLOCKED,
        });
    });

    it('stays silent without a notify adapter', () => {
        const settings = { memoryMode: 'microfiche', microficheGeometry: 'google' };
        expect(gateMicroficheMode({ settings, host: {} })).toEqual({
            ok: false,
            reason: 'no-vision',
        });
    });

    it('passes through non-microfiche without notice', () => {
        const recorder = makeNotifyRecorder();
        expect(
            gateMicroficheMode({
                settings: { memoryMode: 'balanced' },
                host: {},
                notify: recorder,
            }),
        ).toEqual({ ok: true });
        expect(recorder.events).toHaveLength(0);
    });
});

describe('microfiche engine gate', () => {
    it('aborts the auto cycle before preflight with zero requests on no-vision', async () => {
        installSummaryContext({
            settings: { memoryMode: 'microfiche', microficheGeometry: 'google' },
            chat: [],
        });
        const { gate } = makeForegroundGate();
        const recorder = makeNotifyRecorder();
        const queue = { setPhase: vi.fn(), getPhase: () => 'idle' };
        const dispatch = vi.fn();

        const outcome = await runElasticAutoCycle(queue, {
            gate,
            notify: recorder,
            dispatch,
            microficheHost: { canInlineImages: false },
        });

        expect(outcome).toEqual({ status: 'blocked' });
        expect(queue.setPhase).toHaveBeenCalledWith('paused');
        expect(dispatch).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            { type: 'transient', kind: NOTIFY_EVENTS.MICROFICHE_READER_BLOCKED },
        ]);
    });

    it('aborts the auto cycle on no-readers even with a capable host', async () => {
        installSummaryContext({
            settings: { memoryMode: 'microfiche', microficheGeometry: 'custom' },
            chat: [],
        });
        const { gate } = makeForegroundGate();
        const recorder = makeNotifyRecorder();
        const queue = { setPhase: vi.fn(), getPhase: () => 'idle' };
        const dispatch = vi.fn();

        const outcome = await runElasticAutoCycle(queue, {
            gate,
            notify: recorder,
            dispatch,
            microficheHost: { canInlineImages: true },
        });

        expect(outcome).toEqual({ status: 'blocked' });
        expect(dispatch).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            { type: 'transient', kind: NOTIFY_EVENTS.MICROFICHE_GEOMETRY_BLOCKED },
        ]);
    });

    it('aborts a manual run with the blocked verdict on no-vision', async () => {
        const { runManual, ELASTIC_STRATEGIES } = await import('../src/core/summarizer-engine.js');
        const usageLedger = await (await import('./test-helpers.js')).makeUsageLedger();
        installSummaryContext({
            settings: { memoryMode: 'microfiche', microficheGeometry: 'google' },
            chat: [],
        });
        const { gate } = makeForegroundGate();
        const runToken = { end: () => {}, isStopped: () => false };
        const deps = {
            queue: { setPhase: vi.fn(), beginRun: () => runToken },
            refreshUi: vi.fn(),
            withRun: usageLedger.withRun,
            gate,
            dispatch: vi.fn(),
            microficheHost: { canInlineImages: false },
        };
        const recorder = makeNotifyRecorder();

        const outcome = await runManual(deps, ELASTIC_STRATEGIES.FORCE, { notify: recorder });

        expect(outcome).toEqual({ status: 'blocked', completed: 0, failed: 0, totalBatches: 0 });
        expect(deps.dispatch).not.toHaveBeenCalled();
        expect(recorder.events).toEqual([
            { type: 'transient', kind: NOTIFY_EVENTS.MICROFICHE_READER_BLOCKED },
        ]);
    });

    it('lets a supported reader past the gate to the idle verdict', async () => {
        const { runManual, ELASTIC_STRATEGIES } = await import('../src/core/summarizer-engine.js');
        const usageLedger = await (await import('./test-helpers.js')).makeUsageLedger();
        installSummaryContext({
            settings: { memoryMode: 'microfiche', microficheGeometry: 'google' },
            chat: [],
        });
        const { gate } = makeForegroundGate();
        const runToken = { end: () => {}, isStopped: () => false };
        const deps = {
            queue: { setPhase: vi.fn(), beginRun: () => runToken },
            refreshUi: vi.fn(),
            withRun: usageLedger.withRun,
            gate,
            dispatch: vi.fn(),
            microficheHost: { canInlineImages: true },
        };

        const outcome = await runManual(deps, ELASTIC_STRATEGIES.FORCE, {});

        expect(outcome.status).toBe('idle');
        expect(deps.dispatch).not.toHaveBeenCalled();
    });

    it('keeps the atomic route byte-identical for microfiche (R6)', async () => {
        const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });
        const prefixPlan = await buildAutoSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.PREFIX_CACHE),
        );
        const microPlan = await buildAutoSummaryRoutePlan(
            chat,
            makeSummaryStore(),
            readySettings(MEMORY_MODES.MICROFICHE),
        );
        expect(microPlan).toEqual(prefixPlan);
        expect(microPlan.route).toBe(SUMMARY_ROUTES.CACHE_AUTO);
        expect(microPlan.commitMode).toBe(SUMMARY_COMMIT_MODES.ATOMIC_PARTITIONS);
    });
});
