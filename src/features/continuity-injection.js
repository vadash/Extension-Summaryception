import { deriveContinuityCoverage } from '../core/continuity-coverage.js';
import { getChat, setExtensionPrompt } from '../foundation/context.js';
import { EXTENSION_PROMPT_POSITIONS, EXTENSION_PROMPT_ROLES } from '../foundation/constants.js';
import { trace, warn } from '../foundation/logger.js';
import { getEffectiveSettings } from '../foundation/settings.js';

const CONTINUITY_INJECTION_SLOT = 'summaryception_continuity';

// Derived-staleness marker for an un-audited tail; emitted verbatim, "N-1" is literal.
const STALE_CONTINUITY_MARKER = '<!-- active_continuity: cached from turn N-1 -->';

const GATE_LADDER = Object.freeze([
    { minBond: 12, gate: 'intimacy' },
    { minBond: 8, gate: 'kiss' },
    { minBond: 5, gate: 'handhold' },
    { minBond: 2, gate: 'hug' },
]);

/**
 * Bond-to-gate ladder computed at injection time; the Auditor never emits gate
 * text.
 * @param {number} bond
 * @returns {string | null} Gate name, or null below the first rung.
 */
function resolveGate(bond) {
    for (const rung of GATE_LADDER) {
        if (bond >= rung.minBond) {
            return rung.gate;
        }
    }
    return null;
}

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
    return `<active_continuity>\n${sections.join('\n\n')}\n</active_continuity>`;
}

/**
 * Render the live Continuity Checkpoint (ADR-0017) into the dedicated
 * injection slot. Staleness is derived, not stored: the block carries the
 * spec §7 marker and an uncapped depth while newer un-audited Exchanges
 * trail the checkpoint. The slot clears when the extension or the Auditor is
 * disabled, no checkpoint payload exists, or the state renders nothing.
 * @returns {void}
 */
export function updateContinuityInjection() {
    try {
        const settings = getEffectiveSettings();
        const chat = getChat();
        const coverage = deriveContinuityCoverage(chat);
        let text = '';
        let depth = 0;
        let drift = 0;
        if (settings.enabled && settings.continuityEnabled === true && coverage.state) {
            const block = formatContinuityBlock(coverage.state);
            if (block !== '') {
                drift = coverage.unauditedIndices.length;
                text = coverage.stale ? `${STALE_CONTINUITY_MARKER}\n${block}` : block;
                depth = coverage.blockDepth;
            }
        }
        if (text === '') {
            const reason = !settings.enabled
                ? 'extension off'
                : settings.continuityEnabled !== true
                  ? 'auditor off'
                  : coverage.state
                    ? 'state renders empty'
                    : 'no checkpoint payload';
            trace(`Continuity slot cleared: ${reason}`);
            setExtensionPrompt(CONTINUITY_INJECTION_SLOT, '', {
                position: EXTENSION_PROMPT_POSITIONS.NONE,
                depth: 0,
                scan: false,
                role: EXTENSION_PROMPT_ROLES.SYSTEM,
            });
            return;
        }
        const promptViewNote = coverage.rerollTail ? ' (reroll tail excluded)' : '';
        trace(
            `Continuity slot set: checkpoint @${coverage.checkpointIndex}, drift ${drift}, depth ${depth}${promptViewNote}, ${text.length} chars`,
        );
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
