import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { SETTINGS_HELP } from '../src/entry/settings-help-data.js';

const SETTINGS_HTML = readFileSync(new URL('../settings.html', import.meta.url), 'utf8');

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

    it('documents the Continuity Auditor connection route', () => {
        for (const key of [
            'auditor_source',
            'auditor_response_length',
            'auditor_request_timeout',
            'auditor_profile',
        ]) {
            expect(SETTINGS_HELP[key], `missing help entry: ${key}`).toBeDefined();
        }

        expect(SETTINGS_HELP.auditor_source.controls).toContain(
            '#summaryception_auditor_connection_source',
        );
        expect(SETTINGS_HELP.auditor_request_timeout.controls).toContain(
            '#sc_auditor_request_timeout',
        );
    });

    it('renders both Guard Mask toggles in the Advanced Input Processing list', () => {
        expect(SETTINGS_HTML).toContain('id="sc_guard_mask" data-sc-setting="guardMask"');
        expect(SETTINGS_HTML).toContain(
            'id="sc_guard_mask_memory" data-sc-setting="guardMaskMemory"',
        );
    });

    it('documents both Guard Mask toggles with the Q20 copy', () => {
        const main = SETTINGS_HELP.guard_mask;
        const memory = SETTINGS_HELP.guard_mask_memory;

        expect(main).toBeDefined();
        expect(main.title).toBe('Gemini Argoon $$ jailbreak');
        expect(main.short).toBe(
            'Replaces spaces with $$ in chat text sent to the main story model. Storage and the summarizer keep normal text.',
        );
        expect(main.controls).toContain('#sc_guard_mask');

        expect(memory).toBeDefined();
        expect(memory.title).toBe('Gemini Argoon $$ jailbreak for memory');
        expect(memory.short).toBe(
            'Sends stored memories with $$ to the main story model. Needs the main toggle on. Preview shows the masked form.',
        );
        expect(memory.controls).toContain('#sc_guard_mask_memory');
    });
});
