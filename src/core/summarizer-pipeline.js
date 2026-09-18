import { defaultSettings } from '../foundation/constants.js';
import { isTraceEnabled, trace } from '../foundation/logger.js';
import { EXECUTION_TRIGGER_AUDITOR, insertBeforeTrigger } from '../foundation/prompt-parts.js';
import { getEffectiveSettings, getPlayerName } from '../foundation/state.js';
import { appendLayer0PromptConstraints } from './layer0-compression.js';
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
    let prompt = buildSummarizerPrompt({
        template: promptConfig.userPromptTemplate,
        storyTxt,
        contextStr,
        settings,
        metadata: usageMetadata,
    });
    if (metadata.kind === 'auditor' && metadata.auditorRepair) {
        prompt = insertBeforeTrigger(prompt, metadata.auditorRepair, EXECUTION_TRIGGER_AUDITOR);
    }
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

    if (metadata.kind === 'auditor') {
        return {
            systemPrompt: getStringSetting(
                settings.auditorSystemPrompt,
                defaultSettings.auditorSystemPrompt,
            ),
            userPromptTemplate: getStringSetting(
                settings.auditorUserPrompt,
                defaultSettings.auditorUserPrompt,
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
 * @param {object} p
 * @param {string} p.template - User prompt template
 * @param {string} p.storyTxt - Story text
 * @param {string} p.contextStr - Context text
 * @param {ExtensionSettings} p.settings - Active settings
 * @param {import('./summarizer-usage.js').SummarizerCallMetadata} p.metadata - Call metadata
 * @returns {string}
 */
function buildSummarizerPrompt({ template, storyTxt, contextStr, settings, metadata }) {
    // replaceAll on purpose: every placeholder occurrence is replaced; user templates may repeat one.
    const prompt = template
        .replaceAll('{{player_name}}', getPlayerName())
        .replaceAll('{{context_str}}', contextStr || '(none yet)')
        .replaceAll('{{story_txt}}', storyTxt);
    return appendLayer0PromptConstraints(prompt, settings, metadata);
}
