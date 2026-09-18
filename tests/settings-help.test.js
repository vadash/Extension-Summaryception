import { describe, expect, it } from 'vitest';

import { SETTINGS_HELP } from '../src/entry/settings-help-data.js';

describe('settings help data', () => {
    it('documents the Clear Memory button with the reprocess recipe', () => {
        const entry = SETTINGS_HELP.clear_memory;
        expect(entry).toBeDefined();
        expect(entry.controls).toContain('#sc_clear_memory');
        expect(entry.short.trim()).not.toBe('');
        expect(entry.detail).toContain('Clear Memory');
        expect(entry.detail).toContain('Ctrl+F5');
        expect(entry.detail).toContain('Force Summarize');
    });
});
