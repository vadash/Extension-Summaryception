import { describe, expect, it } from 'vitest';

import { UI_MODES } from '../src/foundation/constants.js';
import {
    readOperationMode,
    repairOperationMode,
    selectOff,
    setComplexity,
    setEnabled,
} from '../src/foundation/operation-mode.js';

function makeSettings(overrides = {}) {
    return {
        uiMode: UI_MODES.EASY,
        configMode: UI_MODES.EASY,
        enabled: true,
        ...overrides,
    };
}

describe('readOperationMode', () => {
    it('reports On with the selected Complexity Mode', () => {
        expect(
            readOperationMode(
                makeSettings({ uiMode: UI_MODES.ADVANCED, configMode: UI_MODES.ADVANCED }),
            ),
        ).toEqual({ mode: 'on', complexity: 'advanced', enabled: true });
    });

    it('reports Off with the remembered Complexity Mode as the visible panel', () => {
        expect(
            readOperationMode(
                makeSettings({
                    uiMode: UI_MODES.OFF,
                    configMode: UI_MODES.ADVANCED,
                    enabled: false,
                }),
            ),
        ).toEqual({ mode: 'off', complexity: 'advanced', enabled: false });
    });

    it('folds an unusable Complexity Mode to Easy', () => {
        expect(readOperationMode(makeSettings({ uiMode: 'nonsense' })).complexity).toBe('easy');
    });
});

describe('mode intents', () => {
    it('setComplexity turns the extension On and remembers the panel', () => {
        const settings = makeSettings({ uiMode: UI_MODES.OFF, enabled: false });

        setComplexity(settings, UI_MODES.ADVANCED);

        expect(settings).toMatchObject({
            uiMode: 'advanced',
            configMode: 'advanced',
            enabled: true,
        });
    });

    it('setEnabled(true) restores the remembered Complexity Mode', () => {
        const settings = makeSettings({
            uiMode: UI_MODES.OFF,
            configMode: UI_MODES.ADVANCED,
            enabled: false,
        });

        setEnabled(settings, true);

        expect(settings).toMatchObject({ uiMode: 'advanced', enabled: true });
    });

    it('setEnabled(false) turns Off and keeps the Complexity Mode memory', () => {
        const settings = makeSettings({
            uiMode: UI_MODES.ADVANCED,
            configMode: UI_MODES.ADVANCED,
        });

        setEnabled(settings, false);

        expect(settings).toMatchObject({
            uiMode: 'off',
            configMode: 'advanced',
            enabled: false,
        });
    });

    it('selectOff keeps the Complexity Mode memory', () => {
        const settings = makeSettings({
            uiMode: UI_MODES.ADVANCED,
            configMode: UI_MODES.ADVANCED,
        });

        selectOff(settings);

        expect(settings).toMatchObject({
            uiMode: 'off',
            configMode: 'advanced',
            enabled: false,
        });
    });
});

describe('repairOperationMode', () => {
    it('seeds the mode from a stored disabled gate when no mode was stored', () => {
        const settings = makeSettings({ uiMode: undefined, enabled: false });

        expect(repairOperationMode(settings, { hadUiMode: false })).toBe(true);
        expect(settings.uiMode).toBe(UI_MODES.OFF);
        expect(settings.enabled).toBe(false);
    });

    it('forces the stored gate to follow the mode', () => {
        const settings = makeSettings({ uiMode: UI_MODES.OFF, enabled: true });

        expect(repairOperationMode(settings, { hadUiMode: true })).toBe(true);
        expect(settings.enabled).toBe(false);
    });

    it('repairs an unusable stored mode to the default without moving the gate', () => {
        const settings = makeSettings({ uiMode: 'nonsense' });

        expect(repairOperationMode(settings, { hadUiMode: true })).toBe(false);
        expect(settings.uiMode).toBe(UI_MODES.EASY);
        expect(settings.enabled).toBe(true);
    });

    it('repairs an unusable Complexity Mode memory to the default', () => {
        const settings = makeSettings({ configMode: 'nonsense' });

        repairOperationMode(settings, { hadUiMode: true });

        expect(settings.configMode).toBe(UI_MODES.EASY);
    });

    it('reports no change when the trio already agrees', () => {
        expect(
            repairOperationMode(
                makeSettings({ uiMode: UI_MODES.ADVANCED, configMode: 'advanced' }),
                {
                    hadUiMode: true,
                },
            ),
        ).toBe(false);
    });
});
