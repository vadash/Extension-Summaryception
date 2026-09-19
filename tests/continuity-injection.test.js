import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetCommitStateForTests,
    beginForegroundGeneration,
    initCommitCallbacks,
} from '../src/core/summarizer-commit.js';
import { createDefaultContinuity } from '../src/foundation/continuity.js';
import {
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
    UI_MODES,
} from '../src/foundation/constants.js';
import {
    formatContinuityBlock,
    updateContinuityInjection,
} from '../src/features/continuity-injection.js';
import { installSummaryContext, makeMessage, makeSummaryStore } from './test-helpers.js';

function makeContinuity(overrides = {}) {
    return {
        turn_count: 12,
        bonds: {
            'Quipsy↔User': { bond: 13, sparks: 3, grudge: 0 },
            'Nessa↔User': { bond: 1, sparks: 0, grudge: 2 },
        },
        agendas: {
            Quipsy: {
                task: 'Salon appointment',
                step: { current: 1, max: 3 },
                status: 'arrived',
                body_state: 'None',
                fibs: 'None',
                aware: 'None',
            },
        },
        gm_notes: [
            "[S] Quipsy knows Vova's small size. Vova is unaware she spied.",
            '[T] Friday Sept 20: Vegan Restaurant commitment.',
        ],
        physics: {
            location: 'Velvet Touch Salon',
            environment: 'Quiet mid-afternoon.',
            posture_and_position: 'Quipsy seated; Vova standing ~5m away.',
            contact_points: 'None',
            clothing_state: 'Quipsy in bike shorts and crop top.',
        },
        ...overrides,
    };
}

describe('formatContinuityBlock', () => {
    it('renders the spec §6 block: wrapper, four sections, bonds with gates, secrets, agendas', () => {
        const block = formatContinuityBlock(makeContinuity());

        expect(block.startsWith('<active_continuity>\n')).toBe(true);
        expect(block.endsWith('</active_continuity>')).toBe(true);

        const sections = [
            '[SCENE & POSITIONING]',
            '[RELATIONSHIP GATES]',
            '[SECRETS & ASYMMETRIC KNOWLEDGE]',
            '[ACTIVE AGENDAS & THREADS]',
        ];
        let cursor = -1;
        for (const section of sections) {
            const index = block.indexOf(section, cursor + 1);
            expect(index).toBeGreaterThan(cursor);
            cursor = index;
        }

        expect(block).toContain('Location: Velvet Touch Salon');
        expect(block).toContain('Clothing: Quipsy in bike shorts and crop top.');
        expect(block).toContain('Quipsy↔User: BOND +13 (Sparks: 3, Grudge: 0); Gate: intimacy');
        expect(block).toContain('Nessa↔User: BOND +1 (Sparks: 0, Grudge: 2)');
        expect(block).toContain("[S] Quipsy knows Vova's small size.");
        expect(block).toContain('- Quipsy: Salon appointment (Step 1/3: arrived)');
        expect(block).toContain('[T] Friday Sept 20: Vegan Restaurant commitment.');
    });

    it('renders [S] notes as the secrets section', () => {
        const block = formatContinuityBlock(
            makeContinuity({
                bonds: {},
                agendas: {},
                gm_notes: ['[S] Off-screen event known by one party.'],
                physics: {
                    location: '',
                    environment: '',
                    posture_and_position: '',
                    contact_points: '',
                    clothing_state: '',
                },
            }),
        );

        expect(block).toContain(
            '[SECRETS & ASYMMETRIC KNOWLEDGE]\n- [S] Off-screen event known by one party.',
        );
        expect(block).not.toContain('[ACTIVE AGENDAS & THREADS]');
    });

    it('omits empty sections and labels only non-empty physics fields', () => {
        const block = formatContinuityBlock(
            makeContinuity({
                bonds: {},
                agendas: {},
                gm_notes: [],
                physics: {
                    location: 'Salon',
                    environment: '',
                    posture_and_position: '',
                    contact_points: '',
                    clothing_state: '',
                },
            }),
        );

        expect(block).toContain('[SCENE & POSITIONING]');
        expect(block).toContain('Location: Salon');
        expect(block).not.toContain('Environment:');
        expect(block).not.toContain('Clothing:');
        expect(block).not.toContain('[RELATIONSHIP GATES]');
        expect(block).not.toContain('[SECRETS & ASYMMETRIC KNOWLEDGE]');
        expect(block).not.toContain('[ACTIVE AGENDAS & THREADS]');
    });

    it('renders nothing for a cold-start state', () => {
        expect(formatContinuityBlock(createDefaultContinuity())).toBe('');
    });
});

describe('updateContinuityInjection', () => {
    afterEach(() => {
        resetCommitStateForTests();
        vi.restoreAllMocks();
    });

    /**
     * Attach a Continuity State payload to the named chat message: the
     * payload is the state itself (ADR-0012).
     */
    function attachCheckpoint(chat, scId, state) {
        const message = chat.find((m) => m.sc_id === scId);
        message.extra = message.extra ?? {};
        message.extra.summaryception_continuity = state;
    }

    function installContext({ settings, chat = [] } = {}) {
        const setExtensionPrompt = vi.fn();
        installSummaryContext({
            chat,
            settings,
            metadata: { summaryception: makeSummaryStore() },
            setExtensionPrompt,
        });
        return setExtensionPrompt;
    }

    it('clears the slot when continuity is disabled', () => {
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: false },
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            '',
            EXTENSION_PROMPT_POSITIONS.NONE,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('clears the slot when the extension ui mode is off', () => {
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true, uiMode: UI_MODES.OFF },
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            '',
            EXTENSION_PROMPT_POSITIONS.NONE,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('renders from the live checkpoint and stamps no marker while it covers the last assistant message', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
        ];
        attachCheckpoint(chat, 'a1', makeContinuity());
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const [name, text, position, depth, scan, role] = setExtensionPrompt.mock.calls[0];
        expect(name).toBe('summaryception_continuity');
        expect(text).toContain('<active_continuity>');
        expect(text).toContain('[SECRETS & ASYMMETRIC KNOWLEDGE]');
        expect(text.startsWith('<!--')).toBe(false);
        expect(position).toBe(EXTENSION_PROMPT_POSITIONS.IN_CHAT);
        expect(depth).toBe(1);
        expect(scan).toBe(false);
        expect(role).toBe(EXTENSION_PROMPT_ROLES.SYSTEM);
    });

    it('renders the newest checkpoint even when it sits at or after the last user message', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
            makeMessage({ scId: 'a2' }),
        ];
        const older = makeContinuity({
            turn_count: 1,
            physics: { ...makeContinuity().physics, location: 'Old Salon' },
        });
        const newer = makeContinuity({
            turn_count: 2,
            physics: { ...makeContinuity().physics, location: 'New Kitchen' },
        });
        attachCheckpoint(chat, 'a1', older);
        attachCheckpoint(chat, 'a2', newer);
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
            chat,
        });

        updateContinuityInjection();

        const text = setExtensionPrompt.mock.calls[0][1];
        expect(text).toContain('Location: New Kitchen');
        expect(text).not.toContain('Old Salon');
    });

    it('derives the stale marker and an uncapped depth while newer exchanges trail the checkpoint', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
            makeMessage({ scId: 'a2' }),
            ...Array.from({ length: 9 }, (_, i) => makeMessage({ scId: `extra-${i}` })),
        ];
        attachCheckpoint(chat, 'a1', makeContinuity());
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            expect.stringContaining('<!-- active_continuity: cached from turn N-1 -->'),
            EXTENSION_PROMPT_POSITIONS.IN_CHAT,
            1 + 10,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('renders no block when no live checkpoint exists', () => {
        const chat = [makeMessage({ isUser: true, scId: 'u1' }), makeMessage({ scId: 'a1' })];
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            '',
            EXTENSION_PROMPT_POSITIONS.NONE,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('renders no block when the only payload is not a state object', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
        ];
        attachCheckpoint(chat, 'a1', 'garbage');
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            '',
            EXTENSION_PROMPT_POSITIONS.NONE,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('clears the slot when the rendered block is empty', () => {
        const chat = [
            makeMessage({ isUser: true, scId: 'u1' }),
            makeMessage({ scId: 'a1' }),
            makeMessage({ isUser: true, scId: 'u2' }),
        ];
        attachCheckpoint(chat, 'a1', createDefaultContinuity());
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            '',
            EXTENSION_PROMPT_POSITIONS.NONE,
            0,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('skips prompt mutation while the foreground freeze is active', () => {
        const setExtensionPrompt = installContext({
            settings: { continuityEnabled: true },
        });
        initCommitCallbacks({
            updateInjection: vi.fn(),
            reassertInjection: vi.fn(),
            requeue: vi.fn(),
        });
        beginForegroundGeneration();

        updateContinuityInjection();

        expect(setExtensionPrompt).not.toHaveBeenCalled();
    });
});
