import { defaultSettings } from '../foundation/constants.js';
import { warn, isTraceEnabled, trace } from '../foundation/logger.js';
import { getEffectiveSettings, getPlayerName } from '../foundation/state.js';
import { appendLayer0PromptConstraints } from './layer0-compression.js';
import {
    applyChineseOutputPolicy,
    cleanSummarizerOutput,
    validateLayer0OutputSize,
    validateSummarizerOutputIntegrity,
} from './prompts.js';
import { estimateSummarizerUsage, recordSummarizerUsage } from './summarizer-usage.js';
import { countTextTokens, formatTokenCount } from './token-count.js';

/**
 * @typedef {object} SummarizerPipelineInputRequest
 * @property {string} storyTxt - The story text to summarize
 * @property {string} contextStr - The accumulated context string
 * @property {import('./summarizer-usage.js').SummarizerCallMetadata} [metadata] - Call metadata
 * @property {ExtensionSettings} [settings] - Effective settings override
 */

/**
 * Build the prompt-side inputs for a summarizer request.
 * @param {SummarizerPipelineInputRequest} request
 * @returns {Promise<{ settings: ExtensionSettings, systemPrompt: string, prompt: string, repairPrompt: string, metadata: import('./summarizer-usage.js').SummarizerCallMetadata }>}
 */
export async function buildSummarizerPipelineInput({
    storyTxt,
    contextStr,
    metadata = {},
    settings = getEffectiveSettings(),
}) {
    const usageMetadata = await buildUsageMetadata(metadata, storyTxt);
    const promptConfig = resolveSummarizerPromptConfig(settings, usageMetadata);
    const prompt = buildSummarizerPrompt({
        template: promptConfig.userPromptTemplate,
        storyTxt,
        contextStr,
        settings,
        metadata: usageMetadata,
    });
    const repairPromptTemplate = resolveLayer0RepairPromptTemplate(settings, usageMetadata);
    const repairPrompt = repairPromptTemplate
        ? buildSummarizerPrompt({
              template: repairPromptTemplate,
              storyTxt,
              contextStr,
              settings,
              metadata: {
                  ...usageMetadata,
                  layer0Repair: true,
              },
          })
        : '';

    return {
        settings,
        systemPrompt: promptConfig.systemPrompt,
        prompt,
        repairPrompt,
        metadata: usageMetadata,
    };
}

/**
 * Clean and validate a raw provider response.
 * @param {string} rawResult - Raw provider output
 * @param {ExtensionSettings} settings - Active settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @returns {Promise<{ status: 'success', text: string, error: null, repairFeedback: '' } | { status: 'empty' | 'cn-rejected' | 'integrity-rejected' | 'size-rejected', text: string, error: Error & { retryable?: boolean }, repairFeedback: string }>}
 */
export async function processSummarizerResponse(rawResult, settings, metadata = {}) {
    const cleanedResult = cleanSummarizerOutput((rawResult || '').trim(), {
        stripStructuralMarkers: false,
    });
    const chinesePolicyResult = applyChineseOutputPolicy(cleanedResult, settings);

    if (chinesePolicyResult.error) {
        notifyChinesePolicyRejection(chinesePolicyResult.percent);
        return {
            status: 'cn-rejected',
            text: '',
            error: chinesePolicyResult.error,
            repairFeedback: '',
        };
    }

    if (!chinesePolicyResult.text) {
        return {
            status: 'empty',
            text: '',
            error: new Error('Empty response from summarizer'),
            repairFeedback: '',
        };
    }

    const integrityResult = validateSummarizerOutputIntegrity(chinesePolicyResult.text, metadata);
    if (!integrityResult.valid) {
        warn(integrityResult.error.message);
        return {
            status: 'integrity-rejected',
            text: '',
            error: integrityResult.error,
            repairFeedback: '',
        };
    }

    const sizeResult = await validateLayer0OutputSize(chinesePolicyResult.text, settings, metadata);
    if (!sizeResult.valid) {
        warn(sizeResult.error.message);
        return {
            status: 'size-rejected',
            text: chinesePolicyResult.text,
            error: sizeResult.error,
            repairFeedback: sizeResult.repairFeedback,
        };
    }

    return {
        status: 'success',
        text: sizeResult.text || chinesePolicyResult.text,
        error: null,
        repairFeedback: '',
    };
}

/**
 * Trace token counts for summarizer input text.
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
 * Estimate and record usage for a successful summarizer response.
 * @param {object} p
 * @param {string} p.systemPrompt - System prompt sent to the summarizer
 * @param {string} p.prompt - Fully substituted user prompt
 * @param {string} p.summary - Cleaned summarizer response
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {Promise<import('./summarizer-usage.js').SummarizerTokenUsage>}
 */
export async function recordSuccessfulSummarizerUsage({ systemPrompt, prompt, summary, metadata }) {
    const usage = await estimateSummarizerUsage(systemPrompt, prompt, summary);
    recordSummarizerUsage({
        metadata,
        ...usage,
    });
    return usage;
}

/**
 * Add usage-only details that should not affect prompt labels or routing.
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @param {string} storyTxt - Source text being summarized
 * @returns {Promise<import('./summarizer-usage.js').SummarizerCallMetadata>}
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
 * Resolve the system and user prompt template for a summarizer call.
 * @param {ExtensionSettings} settings - Settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} metadata - Call metadata
 * @returns {{ systemPrompt: string, userPromptTemplate: string }}
 */
function resolveSummarizerPromptConfig(settings, metadata = {}) {
    if (metadata.kind === 'promotion') {
        return {
            systemPrompt: getStringSetting(
                settings.promotionSystemPrompt,
                defaultSettings.promotionSystemPrompt,
            ),
            userPromptTemplate: getStringSetting(
                metadata.promotionRepair
                    ? settings.promotionRepairPrompt
                    : settings.promotionUserPrompt,
                metadata.promotionRepair
                    ? defaultSettings.promotionRepairPrompt
                    : defaultSettings.promotionUserPrompt,
            ),
        };
    }

    return {
        systemPrompt: getStringSetting(
            settings.summarizerSystemPrompt,
            defaultSettings.summarizerSystemPrompt,
        ),
        userPromptTemplate: getStringSetting(
            settings.summarizerUserPrompt,
            defaultSettings.summarizerUserPrompt,
        ),
    };
}

function resolveLayer0RepairPromptTemplate(settings, metadata = {}) {
    if (metadata.kind !== 'layer0' && metadata.kind !== 'regenerate') {
        return '';
    }
    return getStringSetting(
        settings.summarizerRepairPrompt,
        defaultSettings.summarizerRepairPrompt,
    );
}

/**
 * Return a string setting while preserving intentionally empty strings.
 * @param {unknown} value - Candidate setting value
 * @param {string} fallback - Default value for malformed legacy settings
 * @returns {string}
 */
function getStringSetting(value, fallback) {
    return typeof value === 'string' ? value : fallback;
}

/**
 * Build the configured user prompt with runtime substitutions.
 * @param {object} p
 * @param {string} p.template - User prompt template
 * @param {string} p.storyTxt - Story text
 * @param {string} p.contextStr - Context text
 * @param {ExtensionSettings} p.settings - Active settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {string}
 */
function buildSummarizerPrompt({ template, storyTxt, contextStr, settings, metadata }) {
    const sourceState = metadata.sourceState || '(none)';
    const prompt = template
        .replace('{{player_name}}', getPlayerName())
        .replace('{{context_str}}', contextStr || '(none yet)')
        .replace('{{source_state}}', sourceState)
        .replace('{{story_txt}}', storyTxt);
    return appendLayer0PromptConstraints(prompt, settings, metadata);
}

/**
 * Show the existing CN policy warning without coupling prompts.js to UI side effects.
 * @param {string | null} percent
 * @returns {void}
 */
function notifyChinesePolicyRejection(percent) {
    const displayPercent = percent || '?';
    warn(
        `Summarizer response rejected: CN ideographs were ${displayPercent}% of visible characters.`,
    );
    toastr.warning(
        `Summarizer response contained too much CN text (${displayPercent}%). Retrying...`,
        'Summaryception',
        { timeOut: 5000 },
    );
}
