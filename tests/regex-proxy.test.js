import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const CACHE_KEY = 'summaryception_regex_engine_path';

let originalLocalStorage;

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
});

afterEach(() => {
    if (originalLocalStorage) {
        Object.defineProperty(globalThis, 'localStorage', originalLocalStorage);
    } else {
        delete globalThis.localStorage;
    }
    vi.restoreAllMocks();
});

function installLocalStorage(initial = {}) {
    const values = new Map(Object.entries(initial));
    const storage = {
        getItem: vi.fn((key) => (values.has(key) ? values.get(key) : null)),
        setItem: vi.fn((key, value) => values.set(key, String(value))),
        removeItem: vi.fn((key) => values.delete(key)),
    };
    Object.defineProperty(globalThis, 'localStorage', {
        configurable: true,
        value: storage,
    });
    return storage;
}

describe('regex-proxy', () => {
    it('removes an unknown cached regex engine path and falls back to raw text', async () => {
        const storage = installLocalStorage({ [CACHE_KEY]: '../../unexpected.js' });
        const { applyRegexToMessage } = await import('../src/core/regex-proxy.js');

        await expect(applyRegexToMessage('raw text', false, 0)).resolves.toBe('raw text');

        expect(storage.removeItem).toHaveBeenCalledWith(CACHE_KEY);
        expect(storage.setItem).not.toHaveBeenCalled();
    });

    it('removes a known cached regex engine path when it no longer imports', async () => {
        const storage = installLocalStorage({ [CACHE_KEY]: '../../../regex/engine.js' });
        const { applyRegexToMessage } = await import('../src/core/regex-proxy.js');

        await expect(applyRegexToMessage('raw text', true, 2)).resolves.toBe('raw text');

        expect(storage.removeItem).toHaveBeenCalledWith(CACHE_KEY);
    });
});
