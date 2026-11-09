import { describe, expect, it, vi } from 'vitest';

import { resolveCallProfile } from '../src/core/call-profile.js';
import { buildInjection, measureInjection } from '../src/core/memory-injection.js';
import { generateValidatedPromotion } from '../src/core/promotion-candidate.js';
import { buildPromotionPlan } from '../src/core/promotion-planner.js';
import {
    buildAutoSummaryRoutePlan,
    buildForceSummaryRoutePlan,
    buildSlopSummaryRoutePlan,
} from '../src/core/summarization-routes.js';
import { MEMORY_MODES, applyMemoryModePreset } from '../src/foundation/constants.js';
import {
    installSummaryContext,
    makeNotifyRecorder,
    makeSizedChat,
    makeSummaryStore,
    readySettings,
} from './test-helpers.js';

const MODES = [MEMORY_MODES.BALANCED, MEMORY_MODES.PREFIX_CACHE, MEMORY_MODES.MICROFICHE];

// One shared chat and store, so every mode plans from byte-identical inputs.
// Snippet ids stay outside the chat range, so the summarized boundary is -1.
const chat = makeSizedChat(8, { userLength: 400, assistantLength: 400 });

function paritySnippet(index, length) {
    return { text: 'x'.repeat(length), sourceMessageIds: [`msg-a-${index}`] };
}

const layers = [
    Array.from({ length: 4 }, (_, index) => paritySnippet(index, 1000)),
    Array.from({ length: 5 }, (_, index) => paritySnippet(100 + index, 2000)),
];
const store = makeSummaryStore({ layers });

// Ready route budgets plus a promotion size band; every mode starts here.
const baseSettings = { ...readySettings(MEMORY_MODES.BALANCED), layer0SummaryTokenTarget: 100 };

// The preset stamps the mode label with its retention budgets. Parity compares
// retention behavior, so restore the shared budgets and keep only the label different.
function settingsFor(mode) {
    const settings = { ...baseSettings, memoryMode: null };
    applyMemoryModePreset(settings, mode);
    settings.verbatimTokenBudget = baseSettings.verbatimTokenBudget;
    settings.queuedTokenBudget = baseSettings.queuedTokenBudget;
    settings.atomicPartitions = true;
    return settings;
}

const modeSettings = Object.fromEntries(MODES.map((mode) => [mode, settingsFor(mode)]));

// The mode label and the microfiche render split are render-only, outside the
// parity boundary, so drop them before comparing.
function stripRenderOnly(value) {
    if (Array.isArray(value)) {
        return value.map(stripRenderOnly);
    }
    if (value && typeof value === 'object') {
        return Object.fromEntries(
            Object.entries(value)
                .filter(([key]) => key !== 'memoryMode' && key !== 'microfiche')
                .map(([key, entry]) => [key, stripRenderOnly(entry)]),
        );
    }
    return value;
}

function expectParity(values) {
    expect(values).toHaveLength(MODES.length);
    const [first, ...rest] = values.map(stripRenderOnly);
    for (const value of rest) {
        expect(value).toEqual(first);
    }
}

const GOOD_NARRATIVE = 'word '.repeat(30).trim();
const toMerge = layers[0].slice(0, 3);
const storyTxt = toMerge.map((snippet) => snippet.text).join('\n\n');

function preparedFor(mode) {
    const memoryTokensBefore = { count: 400, estimated: false };
    return {
        layerIndex: 0,
        settings: modeSettings[mode],
        mergeCount: 3,
        toMerge,
        sourceNarrativeText: storyTxt,
        memoryTokensBefore,
        storyTxt,
        contextStr: 'context',
        promotedMetadata: { sourceMessageIds: ['msg-0', 'msg-2'] },
        promotionMetadata: {
            kind: 'promotion',
            layerIndex: 0,
            memoryTokensBefore: memoryTokensBefore.count,
            memoryTokensBeforeEstimated: memoryTokensBefore.estimated,
        },
    };
}

function makeDispatch() {
    return vi.fn(async ({ metadata }) => ({
        status: 'completed',
        text: GOOD_NARRATIVE,
        profile: resolveCallProfile(baseSettings, metadata),
    }));
}

describe('mode parity', () => {
    it('builds identical promotion plans across modes', async () => {
        const plans = [];
        for (const mode of MODES) {
            plans.push(await buildPromotionPlan(store, modeSettings[mode]));
        }
        expectParity(plans);
        expect(plans[0].candidate).not.toBeNull();
    });

    it('validates identical promotion candidates across modes', async () => {
        installSummaryContext({ metadata: { summaryception: store } });
        const outcomes = [];
        for (const mode of MODES) {
            const recorder = makeNotifyRecorder();
            const result = await generateValidatedPromotion(preparedFor(mode), {
                notify: recorder,
                dispatch: makeDispatch(),
            });
            outcomes.push({ result, events: recorder.events });
        }
        expectParity(outcomes);
        expect(outcomes[0].result).not.toBeNull();
    });

    it('builds identical injections with identical token costs across modes', async () => {
        const injections = [];
        for (const mode of MODES) {
            const injection = buildInjection(layers, modeSettings[mode]);
            injections.push({ injection, usage: await measureInjection(injection) });
        }
        expectParity(injections);
        expect(injections[0].injection.text).not.toBe('');
        expect(injections[0].usage.total.count).toBeGreaterThan(0);
    });

    it('builds identical route plans across modes', async () => {
        const auto = [];
        const force = [];
        const slop = [];
        for (const mode of MODES) {
            auto.push(await buildAutoSummaryRoutePlan(chat, store, modeSettings[mode]));
            force.push(await buildForceSummaryRoutePlan(chat, store, modeSettings[mode]));
            slop.push(await buildSlopSummaryRoutePlan(chat, store, modeSettings[mode]));
        }
        expectParity(auto);
        expectParity(force);
        expectParity(slop);
        expect(auto[0].ready).toBe(true);
        expect(force[0].ready).toBe(true);
        expect(slop[0].ready).toBe(true);
    });
});
