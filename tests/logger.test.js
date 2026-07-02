import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const debugSettings = { debugMode: true, traceMode: true };
const quietSettings = { debugMode: false, traceMode: false };

let activeSettings = { ...quietSettings };

beforeEach(() => {
    vi.clearAllMocks();
    activeSettings = { ...quietSettings };
    globalThis.SillyTavern = {
        getContext: () => ({
            extensionSettings: {
                summaryception: activeSettings,
            },
        }),
    };
});

import { log, trace, debugVisibleTurns } from '../src/foundation/logger.js';

describe('logger', () => {
    let out;
    let origLog;

    beforeEach(() => {
        out = [];
        origLog = console.log;
        console.log = (...args) => {
            out.push(args);
        };
    });

    afterEach(() => {
        console.log = origLog;
    });

    it('log emits only when debugMode is true', () => {
        activeSettings = { ...debugSettings };
        log('hello');
        expect(out).toHaveLength(1);
        expect(out[0]).toContain('hello');
    });

    it('log is silent when debugMode is false', () => {
        activeSettings = { ...quietSettings };
        log('nope');
        expect(out).toHaveLength(0);
    });

    it('trace emits only when both debugMode and traceMode are true', () => {
        activeSettings = { ...debugSettings };
        trace('entered foo');
        expect(out).toHaveLength(1);
    });

    it('trace uppercases the first string argument', () => {
        activeSettings = { ...debugSettings };
        trace('entered foo');
        expect(out[0]).toContain('ENTERED FOO');
    });

    it('trace is silent when traceMode is off even if debugMode is on', () => {
        activeSettings = { debugMode: true, traceMode: false };
        trace('hidden');
        expect(out).toHaveLength(0);
    });

    it('debugVisibleTurns reports ghosted + visible counts', () => {
        activeSettings = { ...debugSettings };
        const chat = [
            { is_user: true, is_system: false, mes: 'hi', name: 'User', extra: {} },
            { is_user: false, is_system: false, mes: 'reply', name: 'Assistant', extra: {} },
            {
                is_user: false,
                is_system: false,
                mes: 'x',
                name: 'Assistant',
                extra: { sc_ghosted: true },
            },
        ];
        const store = { summarizedUpTo: -1 };
        debugVisibleTurns(chat, store);
        // a trace call was made with '=== DEBUG VISIBLE TURNS ==='
        const joined = out.flat().join(' ');
        expect(joined).toContain('DEBUG VISIBLE TURNS');
        expect(joined).toContain('GHOSTED TURNS');
    });
});
