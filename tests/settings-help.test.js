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

    it('documents both Continuity Auditor connection routes', () => {
        for (const key of [
            'auditor_source',
            'auditor_response_length',
            'auditor_request_timeout',
            'auditor_profile',
            'auditor_fallback_source',
            'auditor_fallback_response_length',
            'auditor_fallback_request_timeout',
            'auditor_fallback_profile',
        ]) {
            expect(SETTINGS_HELP[key], `missing help entry: ${key}`).toBeDefined();
        }

        expect(SETTINGS_HELP.auditor_source.controls).toContain(
            '#summaryception_auditor_connection_source',
        );
        expect(SETTINGS_HELP.auditor_fallback_source.controls).toContain(
            '#summaryception_auditor_fallback_connection_source',
        );
        expect(SETTINGS_HELP.auditor_request_timeout.controls).toContain(
            '#sc_auditor_request_timeout',
        );
    });
});
