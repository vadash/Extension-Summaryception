import { deriveTurnCount, resolveGate } from '../foundation/continuity.js';
import { getChat, setExtensionPrompt } from '../foundation/context.js';
import {
    CATCHUP_WINDOW_EXCHANGES,
    EXTENSION_PROMPT_POSITIONS,
    EXTENSION_PROMPT_ROLES,
} from '../foundation/constants.js';
import { warn } from '../foundation/logger.js';
import { getChatStore, getEffectiveSettings } from '../foundation/state.js';
import { isPromptMutationFrozen } from '../core/summarizer-commit.js';

const CONTINUITY_INJECTION_SLOT = 'summaryception_continuity';

// Spec §7 fail-safe freeze marker; emitted verbatim, "N-1" is literal.
const STALE_CONTINUITY_MARKER = '<!-- active_continuity: cached from turn N-1 -->';

function formatBondLine(pair, { bond, sparks, grudge }) {
    const gate = resolveGate(bond);
    const sign = bond >= 0 ? '+' : '';
    const gateText = gate === null ? '' : `; Gate: ${gate}`;
    return `${pair}: BOND ${sign}${bond} (Sparks: ${sparks}, Grudge: ${grudge})${gateText}`;
}

function formatAgendaLine(name, agenda) {
    return `- ${name}: ${agenda.task} (Step ${agenda.step.current}/${agenda.step.max}: ${agenda.status})`;
}

function formatSection(header, lines) {
    return lines.length === 0 ? null : [header, ...lines].join('\n');
}

/**
 * Dense spec §6 rendering of the Continuity State for the main model: only
 * non-empty sections render, secret notes form the secrets section, and the
 * remaining notes join the agendas as active threads. [S] is the schema's
 * only secrets tag (continuity.js NOTE_TAG_PATTERN), so the renderer never
 * inspects note text beyond that prefix.
 * @param {SummaryceptionContinuityState} state
 * @returns {string} Empty when no section has content.
 */
export function formatContinuityBlock(state) {
    const isSecretNote = (note) => note.startsWith('[S] ');
    const physics = state.physics;
    const notes = state.gm_notes;
    const sections = [
        formatSection(
            '[SCENE & POSITIONING]',
            [
                physics.location && `Location: ${physics.location}`,
                physics.environment && `Environment: ${physics.environment}`,
                physics.posture_and_position && `Physics: ${physics.posture_and_position}`,
                physics.contact_points && `Contact: ${physics.contact_points}`,
                physics.clothing_state && `Clothing: ${physics.clothing_state}`,
            ].filter(Boolean),
        ),
        formatSection(
            '[RELATIONSHIP GATES]',
            Object.entries(state.bonds).map(([pair, bond]) => formatBondLine(pair, bond)),
        ),
        formatSection(
            '[SECRETS & ASYMMETRIC KNOWLEDGE]',
            notes.filter(isSecretNote).map((note) => `- ${note}`),
        ),
        formatSection('[ACTIVE AGENDAS & THREADS]', [
            ...Object.entries(state.agendas).map(([name, agenda]) =>
                formatAgendaLine(name, agenda),
            ),
            ...notes.filter((note) => !isSecretNote(note)).map((note) => `- ${note}`),
        ]),
    ].filter(Boolean);
    if (sections.length === 0) {
        return '';
    }
    const block = `<active_continuity>\n${sections.join('\n\n')}\n</active_continuity>`;
    return state.stale ? `${STALE_CONTINUITY_MARKER}\n${block}` : block;
}

/**
 * Render the chat store's Continuity State into the dedicated injection slot.
 * The slot clears when the extension or the Auditor is disabled or the state
 * renders nothing.
 * @returns {void}
 */
export function updateContinuityInjection() {
    try {
        if (isPromptMutationFrozen()) {
            return;
        }
        const settings = getEffectiveSettings();
        const state = getChatStore().continuity;
        const text =
            settings.enabled && settings.continuityEnabled === true
                ? formatContinuityBlock(state)
                : '';
        if (text === '') {
            setExtensionPrompt(CONTINUITY_INJECTION_SLOT, '', {
                position: EXTENSION_PROMPT_POSITIONS.NONE,
                depth: 0,
                scan: false,
                role: EXTENSION_PROMPT_ROLES.SYSTEM,
            });
            return;
        }
        const drift = deriveTurnCount(getChat(), state.anchor_sc_id) ?? 0;
        // A catch-up covers at most CATCHUP_WINDOW_EXCHANGES exchanges, so the
        // success path bounds the depth bump by that window. A frozen state
        // has no catch-up; the injection must reach past every uncovered
        // exchange so the main model still sees the stale marker.
        const depth = state.stale ? 1 + drift : 1 + Math.min(drift, CATCHUP_WINDOW_EXCHANGES);
        setExtensionPrompt(CONTINUITY_INJECTION_SLOT, text, {
            position: EXTENSION_PROMPT_POSITIONS.IN_CHAT,
            depth,
            scan: false,
            role: EXTENSION_PROMPT_ROLES.SYSTEM,
        });
    } catch (e) {
        warn('updateContinuityInjection error:', e);
    }
}
