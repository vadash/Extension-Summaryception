import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const debugSettings = { debugMode: true, traceMode: true, promptLogMode: true };
const quietSettings = { debugMode: false, traceMode: false, promptLogMode: false };

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

import {
    debug,
    error,
    info,
    isPromptLogEnabled,
    log,
    trace,
    warn,
    debugVisibleTurns,
} from '../src/foundation/logger.js';

describe('logger', () => {
    let out;
    let warnings;
    let errors;
    let origLog;
    let origWarn;
    let origError;

    beforeEach(() => {
        out = [];
        warnings = [];
        errors = [];
        origLog = console.log;
        origWarn = console.warn;
        origError = console.error;
        console.log = (...args) => {
            out.push(args);
        };
        console.warn = (...args) => {
            warnings.push(args);
        };
        console.error = (...args) => {
            errors.push(args);
        };
    });

    afterEach(() => {
        console.log = origLog;
        console.warn = origWarn;
        console.error = origError;
    });

    it('info emits only when debugMode is true', () => {
        activeSettings = { ...debugSettings };
        info('hello');
        expect(out).toHaveLength(1);
        expect(out[0]).toContain('hello');
    });

    it('info is silent when debugMode is false', () => {
        activeSettings = { ...quietSettings };
        info('nope');
        expect(out).toHaveLength(0);
    });

    it('debug and its log alias emit debug-tagged output', () => {
        activeSettings = { ...debugSettings };
        debug('hello');
        log('alias');
        expect(out).toHaveLength(2);
        expect(out[0]).toContain('[DEBUG]');
        expect(out[0]).toContain('hello');
        expect(out[1]).toContain('[DEBUG]');
        expect(out[1]).toContain('alias');
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

    it('warn and error are always visible', () => {
        activeSettings = { ...quietSettings };
        warn('heads up');
        error('boom');
        expect(warnings).toHaveLength(1);
        expect(warnings[0]).toContain('heads up');
        expect(errors).toHaveLength(1);
        expect(errors[0]).toContain('boom');
    });

    it('reports prompt log mode independently of debug mode', () => {
        activeSettings = { debugMode: false, traceMode: false, promptLogMode: true };
        expect(isPromptLogEnabled()).toBe(true);
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
