import { getName1 } from '../foundation/context.js';
import { isTraceEnabled, trace } from '../foundation/logger.js';
import { buildRecallBlock } from '../foundation/prompt-parts.js';
import { getEffectiveSettings } from '../foundation/settings.js';
import { buildCompressionLimits, buildCompressionPayloadFragments } from './layer0-compression.js';
import { resolveCallProfile } from './call-profile.js';
import { countTextTokens, formatTokenCount } from './token-count.js';

/**
 * @typedef {object} SummarizerPipelineInputRequest
 * @property {string} storyTxt - The story text to summarize
 * @property {string} contextStr - The accumulated context string
 * @property {import('./call-profile.js').SummarizerCallMetadata} [metadata] - Resolver input: call category plus provenance
 * @property {ExtensionSettings} [settings] - Effective settings override
 */

/**
 * @typedef {object} SummarizerRequestMessages
 * @property {string} systemPrompt - The static system message for the family
 * @property {string} payload - The first user message: `<in>` plus provenance fragments
 * @property {string} recall - The last user message: recall body, limits, execution trigger
 */

/**
 * Resolve the call profile once at dispatch and render its three messages. The
 * returned profile is frozen policy: the runner consumes it instead of
 * re-deriving per-attempt decisions from the live settings.
 * @param {SummarizerPipelineInputRequest} request
 * @returns {Promise<{ prompt: string, repairPrompt: string, systemPrompt: string, recall: string, repairRecall: string, profile: import('./call-profile.js').CallProfile }>}
 */
export async function buildSummarizerPipelineInput({
    storyTxt,
    contextStr,
    metadata = {},
    settings = getEffectiveSettings(),
}) {
    const call = await buildUsageMetadata(metadata, storyTxt);
    const profile = resolveCallProfile(settings, call);
    const substituted = substitutePlaceholders(profile.policy.userPromptTemplate, {
        storyTxt,
        contextStr,
    });

    // repairPrompt is the Layer 0 family's own retry template; promotion's
    // repair retry swaps the recall tasks and keeps the same payload.
    const repairTemplate = profile.policy.repairPromptTemplate;
    return {
        prompt: buildPayloadMessage(substituted, settings, profile),
        repairPrompt: repairTemplate
            ? buildPayloadMessage(
                  substitutePlaceholders(repairTemplate, { storyTxt, contextStr }),
                  settings,
                  profile,
              )
            : '',
        systemPrompt: profile.policy.systemPrompt,
        recall: buildRecallMessage(profile.policy.recallBody, settings, profile),
        repairRecall: buildRecallMessage(profile.policy.repairRecallBody, settings, profile),
        profile,
    };
}

/**
 * @param {string} storyTxt - Story text
 * @param {string} contextStr - Context text
 * @returns {Promise<void>}
 */
export async function traceSummarizerInputTokens(storyTxt, contextStr) {
    if (!isTraceEnabled()) {
        return;
    }

    const [storyTokens, contextTokens] = await Promise.all([
        countTextTokens(storyTxt || ''),
        countTextTokens(contextStr || ''),
    ]);

    trace('  storyTxt tokens:', formatTokenCount(storyTokens));
    trace('  contextStr tokens:', formatTokenCount(contextTokens));
}

/**
 * Add usage-only details that should not affect prompt labels or routing.
 * @param {import('./call-profile.js').SummarizerCallMetadata} metadata - Call metadata
 * @param {string} storyTxt - Source text being summarized
 * @returns {Promise<import('./call-profile.js').SummarizerCallMetadata>}
 */
async function buildUsageMetadata(metadata = {}, storyTxt = '') {
    let usageMetadata = metadata;

    if (metadata.kind === 'promotion' && !Number.isFinite(Number(metadata.memoryTokensBefore))) {
        const memoryTokens = await countTextTokens(storyTxt || '');
        usageMetadata = {
            ...usageMetadata,
            memoryTokensBefore: memoryTokens.count,
            memoryTokensBeforeEstimated: memoryTokens.estimated,
        };
    }

    if (!hasSourceTokenMetadata(usageMetadata)) {
        const sourceTokens = await countTextTokens(storyTxt || '');
        usageMetadata = {
            ...usageMetadata,
            sourceTokensBefore: sourceTokens.count,
            sourceTokensBeforeEstimated: sourceTokens.estimated,
        };
    }

    return usageMetadata;
}

function hasSourceTokenMetadata(metadata = {}) {
    return (
        Number.isFinite(Number(metadata.sourceTokensBefore)) ||
        Number.isFinite(Number(metadata.regexStats?.finalTokens)) ||
        Number.isFinite(Number(metadata.memoryTokensBefore))
    );
}

/**
 * Fill the payload placeholders. replaceAll on purpose: every occurrence is
 * replaced, because user templates may repeat one.
 * @param {string} template
 * @param {{ storyTxt: string, contextStr: string }} values
 * @returns {string}
 */
function substitutePlaceholders(template, { storyTxt, contextStr }) {
    return template
        .replaceAll('{{player_name}}', getName1())
        .replaceAll('{{context_str}}', contextStr || '(none yet)')
        .replaceAll('{{story_txt}}', storyTxt);
}

/**
 * The first user message: the substituted payload plus the call's provenance
 * fragments (budget hint, source range).
 * @param {string} template
 * @param {ExtensionSettings} settings
 * @param {import('./call-profile.js').CallProfile} profile
 * @returns {string}
 */
function buildPayloadMessage(template, settings, profile) {
    const fragments = buildCompressionPayloadFragments(settings, profile);
    return fragments ? `${template.trimEnd()}\n\n${fragments}` : template;
}

/**
 * The last user message: the family's recall body, the volatile limits, and
 * the execution trigger on the final line.
 * @param {string} body
 * @param {ExtensionSettings} settings
 * @param {import('./call-profile.js').CallProfile} profile
 * @returns {string}
 */
function buildRecallMessage(body, settings, profile) {
    return buildRecallBlock({
        body,
        limits: buildCompressionLimits(settings, profile),
        triggerLine: profile.policy.triggerLine,
    });
}
