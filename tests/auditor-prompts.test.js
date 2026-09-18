import { describe, expect, it } from 'vitest';

import {
    AUDITOR_PROMPT_PRESETS,
    AUDITOR_SYSTEM_PROMPT_PRESETS,
    PROMPT_SETTING_KEYS,
    defaultSettings,
} from '../src/foundation/constants.js';
import {
    DEFAULT_AUDITOR_SYSTEM_PROMPT,
    DEFAULT_AUDITOR_USER_PROMPT,
} from '../src/foundation/prompt-constants.js';
import { getSettings } from '../src/foundation/state.js';
import { installSummaryContext } from './test-helpers.js';

describe('default auditor prompts', () => {
    it('tags gm_notes with [R], [T], and [S] and never [D]', () => {
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('[R]');
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('[T]');
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('[S]');
        expect(DEFAULT_AUDITOR_USER_PROMPT).not.toContain('[D]');
        expect(DEFAULT_AUDITOR_SYSTEM_PROMPT).not.toContain('[D]');
    });

    it('asks the agendas schema for fibs and aware', () => {
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('"fibs"');
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('"aware"');
    });

    it('pins the canonical-name rule', () => {
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('↔User');
        expect(DEFAULT_AUDITOR_SYSTEM_PROMPT).toContain('↔User');
    });

    it('pins the NPC-discovery rule', () => {
        expect(DEFAULT_AUDITOR_USER_PROMPT).toContain('first appearance');
        expect(DEFAULT_AUDITOR_SYSTEM_PROMPT).toContain('first appearance');
    });
});

describe('auditor prompt profile wiring', () => {
    it('appends the auditor pairs after the promotion pairs', () => {
        expect(PROMPT_SETTING_KEYS).toHaveLength(8);
        expect(PROMPT_SETTING_KEYS[6]).toEqual({
            presetKey: 'auditorSystemPromptPreset',
            settingKey: 'auditorSystemPrompt',
        });
        expect(PROMPT_SETTING_KEYS[7]).toEqual({
            presetKey: 'auditorPromptPreset',
            settingKey: 'auditorUserPrompt',
        });
        expect(PROMPT_SETTING_KEYS[5].presetKey).toBe('promotionRepairPromptPreset');
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
