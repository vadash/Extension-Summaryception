import { describe, expect, it } from 'vitest';

import {
    AUDITOR_PROMPT_PRESETS,
    AUDITOR_SYSTEM_PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    AUDITOR_DISCOVERY_RULE,
    AUDITOR_FACT_ROUTING_RULE,
    AUDITOR_NAME_RULE,
    AUDITOR_NOTE_BUDGET,
    AUDITOR_NOTE_KIND_CAPS,
    AUDITOR_NOTE_TOTAL_CAP,
    DEFAULT_AUDITOR_SYSTEM_PROMPT,
    DEFAULT_AUDITOR_USER_PROMPT,
} from '../src/foundation/prompt-constants.js';
import { classifyContinuity } from '../src/core/continuity-state.js';
import { getSettings } from '../src/foundation/settings.js';
import { installSummaryContext } from './test-helpers.js';

describe('default auditor prompts', () => {
    /** Extract one XML section body from a composed prompt template. */
    function sectionBody(prompt, tag) {
        const match = prompt.match(new RegExp(`<${tag}>\\n([\\s\\S]*?)\\n</${tag}>`));
        return match === null ? '' : match[1];
    }

    it('enumerates the [R], [T], and [S] note tags in the output schema listing', () => {
        const schema = sectionBody(DEFAULT_AUDITOR_USER_PROMPT, 'output_schema');
        const gmNotesListing = schema.match(/"gm_notes": \[(.*)\]/);

        expect(gmNotesListing).not.toBeNull();
        const tags = Array.from(gmNotesListing[1].matchAll(/\[([A-Z])\]/g), (m) => m[1]);
        expect(tags).toEqual(['R', 'T', 'S']);
    });

    it('keeps the retired agenda fields out of the output schema', () => {
        const schema = sectionBody(DEFAULT_AUDITOR_USER_PROMPT, 'output_schema');

        expect(schema).toContain('"agendas"');
        expect(schema).not.toContain('"body_state"');
        expect(schema).not.toContain('"fibs"');
        expect(schema).not.toContain('"aware"');
    });

    it('states the GM-note budget the code actually enforces', () => {
        const { state } = classifyContinuity(
            JSON.stringify({
                turn_count: 1,
                bonds: {},
                agendas: {},
                gm_notes: [
                    ...Array.from({ length: 6 }, (_, i) => `[R] Reminder ${i + 1}`),
                    ...Array.from({ length: 10 }, (_, i) => `[T] Thread ${i + 1}`),
                    ...Array.from({ length: 14 }, (_, i) => `[S] Secret ${i + 1}`),
                ],
                physics: {},
            }),
        );
        const kept = { R: 0, T: 0, S: 0 };
        for (const note of state.gm_notes) {
            kept[note[1]] += 1;
        }

        // The code keeps exactly the budget the prompt states.
        expect(kept).toEqual(AUDITOR_NOTE_KIND_CAPS);
        expect(state.gm_notes).toHaveLength(AUDITOR_NOTE_TOTAL_CAP);
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain(AUDITOR_NOTE_BUDGET);
    });

    it('routes each state fact to its one home in the task rules', () => {
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain(AUDITOR_FACT_ROUTING_RULE);
    });

    it('wires the canonical-name and NPC-discovery rules into both prompts', () => {
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain(AUDITOR_NAME_RULE);
        expect(DEFAULT_AUDITOR_SYSTEM_PROMPT).toContain(AUDITOR_NAME_RULE);
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain(AUDITOR_DISCOVERY_RULE);
        expect(DEFAULT_AUDITOR_SYSTEM_PROMPT).toContain(AUDITOR_DISCOVERY_RULE);
    });
});

describe('auditor prompt profile wiring', () => {
    it('registers the auditor pairs after the promotion pairs', () => {
        const bySettingKey = (settingKey) =>
            PROMPT_SETTING_KEYS.find((key) => key.settingKey === settingKey);
        expect(bySettingKey('auditorSystemPrompt')).toEqual({
            presetKey: 'auditorSystemPromptPreset',
            settingKey: 'auditorSystemPrompt',
        });
        expect(bySettingKey('auditorUserPrompt')).toEqual({
            presetKey: 'auditorPromptPreset',
            settingKey: 'auditorUserPrompt',
        });
        const indexOfSetting = (settingKey) =>
            PROMPT_SETTING_KEYS.findIndex((key) => key.settingKey === settingKey);
        const promotionIndex = indexOfSetting('promotionRepairPrompt');
        const systemIndex = indexOfSetting('auditorSystemPrompt');
        const userIndex = indexOfSetting('auditorUserPrompt');
        expect(promotionIndex).toBeGreaterThanOrEqual(0);
        expect(systemIndex).toBeGreaterThan(promotionIndex);
        expect(userIndex).toBeGreaterThan(systemIndex);
    });

    it('defaults both auditor presets to continuity', () => {
        expect(defaultSettings.auditorSystemPromptPreset).toBe('continuity');
        expect(defaultSettings.auditorPromptPreset).toBe('continuity');
        expect(AUDITOR_SYSTEM_PROMPT_PRESETS.continuity).toBe(defaultSettings.auditorSystemPrompt);
        expect(AUDITOR_PROMPT_PRESETS.continuity).toBe(defaultSettings.auditorUserPrompt);
        expect(AUDITOR_SYSTEM_PROMPT_PRESETS.custom).toBeNull();
        expect(AUDITOR_PROMPT_PRESETS.custom).toBeNull();
    });

    it('normalizes invalid auditor presets back to the registered defaults', () => {
        installSummaryContext({
            settings: {
                auditorSystemPromptPreset: 'bogus',
                auditorSystemPrompt: 'drifted text',
                auditorPromptPreset: 'also-bogus',
                auditorUserPrompt: 'drifted text',
            },
        });

        const s = getSettings();
        expect(s.auditorSystemPromptPreset).toBe('continuity');
        expect(s.auditorSystemPrompt).toBe(defaultSettings.auditorSystemPrompt);
        expect(s.auditorPromptPreset).toBe('continuity');
        expect(s.auditorUserPrompt).toBe(defaultSettings.auditorUserPrompt);
    });

    it('keeps saved continuity selections and custom auditor text through normalization', () => {
        installSummaryContext({
            settings: {
                auditorSystemPromptPreset: 'continuity',
                auditorSystemPrompt: defaultSettings.auditorSystemPrompt,
                auditorPromptPreset: 'custom',
                auditorUserPrompt: 'my auditor prompt',
            },
        });

        const s = getSettings();
        expect(s.auditorSystemPromptPreset).toBe('continuity');
        expect(s.auditorPromptPreset).toBe('custom');
        expect(s.auditorUserPrompt).toBe('my auditor prompt');
    });
});
