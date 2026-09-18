import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    resetCommitStateForTests,
    beginForegroundGeneration,
    initCommitCallbacks,
} from '../src/core/summarizer-commit.js';
import { createDefaultContinuity } from '../src/foundation/continuity.js';
import { EXTENSION_PROMPT_POSITIONS, EXTENSION_PROMPT_ROLES } from '../src/foundation/constants.js';
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
        anchor_sc_id: 'message-12',
        stale: false,
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

    it('renders spec-style [D] notes as secrets too', () => {
        const block = formatContinuityBlock(
            makeContinuity({
                bonds: {},
                agendas: {},
                gm_notes: ['[D] Off-screen event known by one party.'],
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
            '[SECRETS & ASYMMETRIC KNOWLEDGE]\n- [D] Off-screen event known by one party.',
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

    it('prepends the spec-verbatim stale marker only when the state is stale', () => {
        const stale = formatContinuityBlock(makeContinuity({ stale: true }));
        expect(stale.startsWith('<!-- active_continuity: cached from turn N-1 -->\n')).toBe(true);
        expect(stale).toContain('<active_continuity>');

        const fresh = formatContinuityBlock(makeContinuity({ stale: false }));
        expect(fresh).not.toContain('<!--');
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

    function installWithContinuity({ settings, continuity = makeContinuity(), chat = [] } = {}) {
        const setExtensionPrompt = vi.fn();
        const ctx = installSummaryContext({
            chat,
            settings,
            metadata: { summaryception: makeSummaryStore({ continuity }) },
            setExtensionPrompt,
        });
        return { ctx, setExtensionPrompt };
    }

    it('clears the slot when continuity is disabled', () => {
        const { setExtensionPrompt } = installWithContinuity({
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

    it('injects the rendered block at In-Chat depth one past the unanchored drift', () => {
        const chat = [
            makeMessage({ scId: 'anchor', isUser: false }),
            makeMessage({ scId: 'u1', isUser: true }),
            makeMessage({ scId: 'a2', isUser: false }),
            makeMessage({ scId: 'a3', isUser: false }),
        ];
        const { setExtensionPrompt } = installWithContinuity({
            settings: { continuityEnabled: true },
            continuity: makeContinuity({ anchor_sc_id: 'anchor' }),
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledTimes(1);
        const [name, text, position, depth, scan, role] = setExtensionPrompt.mock.calls[0];
        expect(name).toBe('summaryception_continuity');
        expect(text).toContain('<active_continuity>');
        expect(text).toContain('[SECRETS & ASYMMETRIC KNOWLEDGE]');
        expect(position).toBe(EXTENSION_PROMPT_POSITIONS.IN_CHAT);
        expect(depth).toBe(3);
        expect(scan).toBe(false);
        expect(role).toBe(EXTENSION_PROMPT_ROLES.SYSTEM);
    });

    it('clamps the depth bump to the combined catch-up window', () => {
        const chat = [
            makeMessage({ scId: 'anchor', isUser: false }),
            ...Array.from({ length: 9 }, (_, i) =>
                makeMessage({ scId: `extra-${i}`, isUser: false }),
            ),
        ];
        const { setExtensionPrompt } = installWithContinuity({
            settings: { continuityEnabled: true },
            continuity: makeContinuity({ anchor_sc_id: 'anchor' }),
            chat,
        });

        updateContinuityInjection();

        expect(setExtensionPrompt).toHaveBeenCalledWith(
            'summaryception_continuity',
            expect.any(String),
            EXTENSION_PROMPT_POSITIONS.IN_CHAT,
            1 + 4,
            false,
            EXTENSION_PROMPT_ROLES.SYSTEM,
        );
    });

    it('clears the slot when the rendered block is empty', () => {
        const { setExtensionPrompt } = installWithContinuity({
            settings: { continuityEnabled: true },
            continuity: createDefaultContinuity(),
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
        const { setExtensionPrompt } = installWithContinuity({
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
