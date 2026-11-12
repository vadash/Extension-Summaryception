import { describe, expect, it } from 'vitest';

import { maskGuardContent } from '../src/core/guard-mask.js';
import { maskUserRoleAsAssistantInGenerateData } from '../src/core/assistant-role-mask.js';
import { applyOutgoingSeamToPreview } from '../src/entry/dryrun-viewer.js';
import { defaultSettings } from '../src/foundation/constants.js';
import { installSummaryContext } from './test-helpers.js';

const LAST_CHAT = 'I open the door.';
const PRESET_ONE = 'Think step by step before answering.';
const PRESET_TWO = 'Second preset reasoning block.';
const PRESET_THREE = 'Third preset reasoning block.';

/** Guard settings with the trailing Preset CoT policy a test names. */
function guardSettings(overrides = {}) {
    const { modelName, ...rest } = overrides;
    const mocks = globalThis.summaryceptionFoundationMocks?.context;
    mocks?.getActiveModelName?.mockReturnValue(modelName ?? 'gemini-2.5-pro');
    return {
        enabled: true,
        guardMask: true,
        guardMaskMemory: true,
        guardMaskCotMode: 'auto',
        guardMaskCotCount: 2,
        ...rest,
    };
}

/** Install the live chat whose last message is the anchor candidate. */
function installLiveChat(mes = LAST_CHAT, extra = {}) {
    installSummaryContext({ chat: [{ name: 'Player1', is_user: true, mes, ...extra }] });
}

/** Chat history plus one trailing merged Preset CoT user message. */
function promptWithOnePreset() {
    return [
        { role: 'system', content: 'preset system' },
        { role: 'user', content: 'Earlier chat line.' },
        { role: 'assistant', content: 'Earlier chat reply.' },
        { role: 'user', content: LAST_CHAT },
        { role: 'user', content: PRESET_ONE },
    ];
}

describe('guard mask trailing Preset CoT exemption', () => {
    it('ships auto with a two-message window', () => {
        expect(defaultSettings.guardMaskCotMode).toBe('auto');
        expect(defaultSettings.guardMaskCotCount).toBe(2);
    });

    it('on with slider 3 exempts the merged trailing preset and masks chat content', () => {
        installLiveChat();
        const messages = promptWithOnePreset();

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 3 }));

        expect(messages[4].content).toBe(PRESET_ONE);
        expect(messages[1].content).toBe('Earlier$$chat$$line.');
        expect(messages[2].content).toBe('Earlier$$chat$$reply.');
        expect(messages[3].content).toBe('I$$open$$the$$door.');
    });

    it('auto exempts exactly two trailing user messages regardless of the slider', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            { role: 'user', content: PRESET_ONE },
            { role: 'user', content: PRESET_TWO },
            { role: 'user', content: PRESET_THREE },
        ];

        maskGuardContent(
            messages,
            guardSettings({ guardMaskCotMode: 'auto', guardMaskCotCount: 5 }),
        );

        expect(messages[2].content).toBe(PRESET_ONE);
        expect(messages[3].content).toBe(PRESET_TWO);
        expect(messages[4].content).toBe('Third$$preset$$reasoning$$block.');
        expect(messages[1].content).toBe('I$$open$$the$$door.');
    });

    it('on clamps the slider to the declared 1-5 bounds', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            ...Array.from({ length: 6 }, (_, index) => ({
                role: 'user',
                content: `preset reasoning ${index}`,
            })),
        ];

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 9 }));

        expect(messages.slice(2, 7).map((message) => message.content)).toEqual([
            'preset reasoning 0',
            'preset reasoning 1',
            'preset reasoning 2',
            'preset reasoning 3',
            'preset reasoning 4',
        ]);
        expect(messages[7].content).toBe('preset$$reasoning$$5');
    });

    it('a missing mode behaves as auto', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            { role: 'user', content: PRESET_ONE },
            { role: 'user', content: PRESET_TWO },
            { role: 'user', content: PRESET_THREE },
        ];

        maskGuardContent(
            messages,
            guardSettings({ guardMaskCotMode: undefined, guardMaskCotCount: 5 }),
        );

        expect(messages[2].content).toBe(PRESET_ONE);
        expect(messages[3].content).toBe(PRESET_TWO);
        expect(messages[4].content).toBe('Third$$preset$$reasoning$$block.');
    });

    it('off masks every trailing preset and every chat message', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            { role: 'user', content: PRESET_ONE },
            { role: 'user', content: PRESET_TWO },
        ];

        maskGuardContent(
            messages,
            guardSettings({ guardMaskCotMode: 'off', guardMaskCotCount: 3 }),
        );

        expect(messages[1].content).toBe('I$$open$$the$$door.');
        expect(messages[2].content).toBe('Think$$step$$by$$step$$before$$answering.');
        expect(messages[3].content).toBe('Second$$preset$$reasoning$$block.');
    });

    it('on with a slider above the available tail stops at the available messages', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            { role: 'user', content: PRESET_ONE },
            { role: 'user', content: PRESET_TWO },
        ];

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 5 }));

        expect(messages[2].content).toBe(PRESET_ONE);
        expect(messages[3].content).toBe(PRESET_TWO);
        expect(messages[1].content).toBe('I$$open$$the$$door.');
    });

    it('a trailing assistant preset message stays masked and does not consume the window', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            { role: 'user', content: PRESET_ONE },
            { role: 'assistant', content: 'assistant preset bias text' },
            { role: 'user', content: PRESET_TWO },
        ];

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 3 }));

        expect(messages[2].content).toBe(PRESET_ONE);
        expect(messages[3].content).toBe('assistant$$preset$$bias$$text');
        expect(messages[4].content).toBe(PRESET_TWO);
    });

    it('an anchor miss masks every trailing preset message', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: 'Earlier chat line.' },
            { role: 'user', content: PRESET_ONE },
        ];

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 3 }));

        expect(messages[1].content).toBe('Earlier$$chat$$line.');
        expect(messages[2].content).toBe('Think$$step$$by$$step$$before$$answering.');
    });

    it('matches an anchor that the host flattened behind a speaker name', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: `Player1: ${LAST_CHAT}` },
            { role: 'user', content: PRESET_ONE },
        ];

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 3 }));

        expect(messages[1].content).toBe('Player1:$$I$$open$$the$$door.');
        expect(messages[2].content).toBe(PRESET_ONE);
    });

    it('exempts a multipart trailing preset message as one message', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            {
                role: 'user',
                content: [
                    { type: 'text', text: PRESET_ONE },
                    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
                ],
            },
        ];

        maskGuardContent(messages, guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 3 }));

        expect(messages[1].content).toBe('I$$open$$the$$door.');
        expect(messages[2].content).toEqual([
            { type: 'text', text: PRESET_ONE },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } },
        ]);
    });
});

describe('guard mask trailing exemption through the outgoing seam', () => {
    it('applies the post-rewrite roles, so a rewritten preset user message stays masked', () => {
        installLiveChat();
        const messages = [
            { role: 'system', content: 'preset system' },
            { role: 'user', content: LAST_CHAT },
            { role: 'user', content: PRESET_ONE },
        ];

        maskUserRoleAsAssistantInGenerateData(
            { prompt: messages },
            guardSettings({
                guardMaskCotMode: 'on',
                guardMaskCotCount: 3,
                maskUserRoleAsAssistant: true,
                maskUserRoleMode: 'marker_first',
            }),
        );

        expect(messages[2].content).toBe('I$$open$$the$$door.');
        expect(messages[3].role).toBe('assistant');
        expect(messages[3].content).toBe('Think$$step$$by$$step$$before$$answering.');
    });

    it('the Dry-Run Preview clone matches the live prompt through the same seam', () => {
        installLiveChat();
        const live = promptWithOnePreset();
        const preview = structuredClone(live);
        const settings = guardSettings({ guardMaskCotMode: 'on', guardMaskCotCount: 3 });

        maskUserRoleAsAssistantInGenerateData({ prompt: live }, settings);
        applyOutgoingSeamToPreview(preview, settings);

        expect(preview).toEqual(live);
        expect(preview[4].content).toBe(PRESET_ONE);
        expect(preview[3].content).toBe('I$$open$$the$$door.');
    });
});

describe('guard mask model gate', () => {
    it('masks spaces on an argon model name', () => {
        installLiveChat();
        const messages = [{ role: 'user', content: 'hello world' }];

        maskGuardContent(
            messages,
            guardSettings({ guardMaskCotMode: 'off', modelName: 'Argon-Gemini-1' }),
        );

        expect(messages[0].content).toBe('hello$$world');
    });

    it('unmasks $$ on a non-matching model while the toggle stays on', () => {
        installLiveChat();
        const messages = [
            { role: 'user', content: 'hello$$world' },
            { role: 'assistant', content: [{ type: 'text', text: 'hi$$there' }] },
        ];

        maskGuardContent(
            messages,
            guardSettings({ guardMaskCotMode: 'off', modelName: 'gpt-4o-mini' }),
        );

        expect(messages[0].content).toBe('hello world');
        expect(messages[1].content).toEqual([{ type: 'text', text: 'hi there' }]);
    });

    it('unmasks $$ while the toggle is off on a matching model', () => {
        installLiveChat();
        const messages = [{ role: 'user', content: 'hello$$world' }];

        maskGuardContent(
            messages,
            guardSettings({
                guardMask: false,
                guardMaskCotMode: 'off',
                modelName: 'gemini-2.5-pro',
            }),
        );

        expect(messages[0].content).toBe('hello world');
    });

    it('leaves user and assistant text alone when the extension is off', () => {
        installLiveChat();
        const messages = [{ role: 'user', content: 'hello$$world' }];

        maskGuardContent(
            messages,
            guardSettings({ enabled: false, guardMaskCotMode: 'off', modelName: 'gemini-2.5-pro' }),
        );

        expect(messages[0].content).toBe('hello$$world');
    });
});
