import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MEMORY_MODES } from '../src/foundation/constants.js';
import { bindDataSettingElements, readLines } from '../src/entry/ui-bind.js';
import { getSettings } from '../src/foundation/state.js';
import { buildMainContextPreviewModel, buildTriggerGaugeModel } from '../src/entry/ui.js';
import { installSummaryContext } from './test-helpers.js';

describe('context limit and trigger gauge UI models', () => {
    it('builds the main-request range from memory, verbatim, and queued budgets for both modes', () => {
        const base = {
            memoryTokenBudget: 10000,
            verbatimTokenBudget: 16000,
            queuedTokenBudget: 32000,
        };
        expect(
            buildMainContextPreviewModel({ ...base, memoryMode: MEMORY_MODES.BALANCED }),
        ).toEqual({
            rawChatMin: 16000,
            rawChatMax: 48000,
            mainMin: 26000,
            mainMax: 58000,
        });
        expect(
            buildMainContextPreviewModel({ ...base, memoryMode: MEMORY_MODES.PREFIX_CACHE }),
        ).toEqual({
            rawChatMin: 16000,
            rawChatMax: 48000,
            mainMin: 26000,
            mainMax: 58000,
        });
    });

    it('builds the queued gauge from queued planner stats and the queued budget', () => {
        expect(
            buildTriggerGaugeModel(
                {
                    rawPlan: { queuedStats: { finalTokens: 4321.2, finalTokensEstimated: true } },
                },
                { queuedTokenBudget: 16000 },
            ),
        ).toEqual({
            queuedTokens: 4322,
            queuedEstimated: true,
            triggerTokens: 16000,
            label: 'Summarize at Recent + Queued',
        });
    });
});

/**
 * Minimal jQuery stand-in for the binding engine: string selectors resolve by
 * exact match against the registered elements (comma lists supported).
 * @param {Array<{ selector: string, attrs: Record<string, string>, value?: string }>} elements
 * @returns {{ $: (target: unknown) => unknown, element: (selector: string) => object, fire: (selector: string, eventName: string) => void }}
 */
function makeSettingsDomStub(elements) {
    const handlers = new Map();
    const wrapperBySelector = new Map();
    const wrapperByNode = new Map();
    for (const spec of elements) {
        const state = { attrs: { ...spec.attrs }, value: spec.value ?? '', props: {} };
        const node = {};
        const wrapper = {
            attr(name) {
                return state.attrs[name];
            },
            is(selector) {
                return selector === ':checkbox' && state.attrs.type === 'checkbox';
            },
            on(eventName, handler) {
                handlers.set(`${spec.selector}|${eventName}`, handler);
                return wrapper;
            },
            prop(name, nextValue) {
                if (arguments.length === 1) {
                    return state.props[name];
                }
                state.props[name] = nextValue;
                return wrapper;
            },
            val(...args) {
                if (args.length === 0) {
                    return state.value;
                }
                state.value = args[0];
                return wrapper;
            },
            each(callback) {
                callback.call(node, 0, node);
                return wrapper;
            },
        };
        wrapperBySelector.set(spec.selector, wrapper);
        wrapperByNode.set(node, wrapper);
    }
    const $ = (target) => {
        if (typeof target !== 'string') {
            return wrapperByNode.get(target);
        }
        const matched = String(target)
            .split(',')
            .map((part) => part.trim())
            .map((part) => wrapperBySelector.get(part))
            .filter(Boolean);
        return {
            each(callback) {
                matched.forEach((wrapper, index) => {
                    const node = [...wrapperByNode.entries()].find(([, w]) => w === wrapper)?.[0];
                    callback.call(node, index, node);
                });
            },
        };
    };
    return {
        $,
        element: (selector) => wrapperBySelector.get(selector),
        fire(selector, eventName) {
            const handler = handlers.get(`${selector}|${eventName}`);
            if (!handler) {
                throw new Error(`No ${eventName} handler bound for ${selector}`);
            }
            handler();
        },
    };
}

describe('data-attr setting binding engine', () => {
    beforeEach(() => {
        installSummaryContext({ settings: { debugMode: false, stripPatterns: [] } });
    });

    it('reads textarea content as trimmed non-empty lines', () => {
        expect(readLines({ val: () => '  foo\n\n  bar \n   \nbaz' })).toEqual([
            'foo',
            'bar',
            'baz',
        ]);
        expect(readLines({ val: () => '' })).toEqual([]);
    });

    it('binds checkbox settings from data attributes on change and syncs at bind time', () => {
        const dom = makeSettingsDomStub([
            {
                selector: '#sc_debug_mode',
                attrs: { type: 'checkbox', 'data-sc-setting': 'debugMode' },
            },
        ]);
        globalThis.$ = dom.$;

        bindDataSettingElements('#sc_debug_mode', { eventName: 'change' });

        expect(dom.element('#sc_debug_mode').prop('checked')).toBe(false);
        expect(() => dom.fire('#sc_debug_mode', 'input')).toThrow('No input handler');
        dom.element('#sc_debug_mode').prop('checked', true);
        dom.fire('#sc_debug_mode', 'change');
        expect(getSettings().debugMode).toBe(true);
    });

    it('binds lines and plain string settings from their declared data types', () => {
        const dom = makeSettingsDomStub([
            {
                selector: '#sc_strip_patterns',
                attrs: { 'data-sc-setting': 'stripPatterns', 'data-sc-type': 'lines' },
            },
            {
                selector: '#sc_custom_memory_position',
                attrs: { 'data-sc-setting': 'customMemoryPosition' },
            },
        ]);
        globalThis.$ = dom.$;
        const afterSave = vi.fn();

        bindDataSettingElements('#sc_strip_patterns, #sc_custom_memory_position', {
            eventName: 'change',
            afterSave,
        });

        dom.element('#sc_strip_patterns').val('  foo\n\nbar ');
        dom.fire('#sc_strip_patterns', 'change');
        dom.fire('#sc_custom_memory_position', 'change');
        expect(getSettings().stripPatterns).toEqual(['foo', 'bar']);
        expect(getSettings().customMemoryPosition).toBe('in_prompt');
        expect(afterSave).toHaveBeenCalledTimes(2);
    });
});
