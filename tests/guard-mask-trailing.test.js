import { describe, expect, it } from 'vitest';

import {
    isGuardMaskEnabled,
    maskGuardContentParts,
    maskGuardText,
    unmaskGuardContentParts,
    unmaskGuardText,
} from '../src/core/guard-mask.js';
import { defaultSettings } from '../src/foundation/constants.js';

const B = '\u2800';

/** Guard settings with the model gate a test names. */
function guardSettings(overrides = {}) {
    const { modelName, ...rest } = overrides;
    const mocks = globalThis.summaryceptionFoundationMocks?.context;
    mocks?.getActiveModelName?.mockReturnValue(modelName ?? 'gemini-2.5-pro');
    return {
        enabled: true,
        guardMask: true,
        ...rest,
    };
}

describe('guard mask model gate', () => {
    it('masks whitespace on an argon model name', () => {
        guardSettings({ modelName: 'Argon-Gemini-1' });

        expect(isGuardMaskEnabled({ guardMask: true })).toBe(true);
        expect(maskGuardText('hello world')).toBe(`hello${B}world`);
    });

    it('masks on an opus model name', () => {
        guardSettings({ modelName: 'claude-opus-4-6' });

        expect(isGuardMaskEnabled({ guardMask: true })).toBe(true);
    });

    it('reads the gate case-insensitively for opus', () => {
        guardSettings({ modelName: 'CLAUDE-OPUS-4-6' });

        expect(isGuardMaskEnabled({ guardMask: true })).toBe(true);
        expect(isGuardMaskEnabled({ guardMask: false })).toBe(false);
    });

    it('stays disabled behind a non-matching model', () => {
        guardSettings({ modelName: 'gpt-4o-mini' });

        expect(isGuardMaskEnabled({ guardMask: true })).toBe(false);
    });

    it('ships the gate off by default', () => {
        expect(defaultSettings.guardMask).toBe(false);
    });
});

describe('guard mask codec', () => {
    it('encodes a horizontal whitespace run as one braille blank', () => {
        expect(maskGuardText('hello  world')).toBe(`hello${B}world`);
        expect(maskGuardText('a\t\tb')).toBe(`a${B}b`);
    });

    it('keeps newlines and encodes the runs around them', () => {
        expect(maskGuardText('a \n b')).toBe(`a${B}\n${B}b`);
        expect(maskGuardText('a\r\nb')).toBe('a\r\nb');
        expect(
            maskGuardText(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`),
        ).toBe(`a${String.fromCharCode(0x2028)}b${String.fromCharCode(0x2029)}c`);
    });

    it('substitutes whitespace only and leaves letters untouched', () => {
        expect(maskGuardText('plain text')).toBe(`plain${B}text`);
        expect(maskGuardText('abc')).toBe('abc');
    });

    it('is idempotent, so an existing braille blank stays as-is', () => {
        const once = maskGuardText('hello  world');

        expect(maskGuardText(once)).toBe(once);
        expect(maskGuardText(`a${B}b`)).toBe(`a${B}b`);
    });

    it('folds both the braille blank and legacy $$ to one space each', () => {
        expect(unmaskGuardText(`a${B}b`)).toBe('a b');
        expect(unmaskGuardText('a$$b')).toBe('a b');
        expect(unmaskGuardText(`a${B}b$$c`)).toBe('a b c');
    });

    it('masks and unmasks text parts while leaving image parts opaque', () => {
        const content = [
            { type: 'text', text: 'hello  world' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ];

        maskGuardContentParts(content);

        expect(content[0].text).toBe(`hello${B}world`);
        expect(content[1]).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAAA' },
        });

        unmaskGuardContentParts(content);

        expect(content[0].text).toBe('hello world');
        expect(content[1]).toEqual({
            type: 'image_url',
            image_url: { url: 'data:image/png;base64,AAAA' },
        });
    });
});
