import { layerLabel, listNonEmptyLayers } from '../foundation/constants.js';
import { getChat, getSlashCommand, getSlashCommandParser } from '../foundation/context.js';
import { warn } from '../foundation/logger.js';
import { getChatStore, getCurrentSummarizedBoundary } from '../foundation/state.js';
import { assembleSummaryBlock } from '../features/injection.js';
import { clearSummaryceptionMemory } from '../features/memory.js';

// ─── Slash Commands ──────────────────────────────────────────────────

/**
 *
 */
export function registerSlashCommands() {
    try {
        const SlashCommandParser = getSlashCommandParser();
        const SlashCommand = getSlashCommand();

        if (!SlashCommandParser?.addCommandObject || !SlashCommand) {
            warn('SlashCommandParser not available, skipping command registration.');
            return;
        }

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-status',
                callback: () => {
                    const store = getChatStore();
                    const boundary = getCurrentSummarizedBoundary(getChat(), store);
                    const lines = ['**Summaryception Status**'];
                    lines.push(
                        boundary < 0 ? 'No summaries.' : `Current summarized boundary: ${boundary}`,
                    );
                    const nonEmptyLayers = listNonEmptyLayers(store);
                    for (let k = nonEmptyLayers.length - 1; k >= 0; k--) {
                        const { index, layer } = nonEmptyLayers[k];
                        lines.push(`${layerLabel(index)}: ${layer.length} snippets`);
                    }
                    return lines.join('\n');
                },
                helpString: 'Show Summaryception layer status',
            }),
        );

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-clear',
                callback: async () => {
                    await clearSummaryceptionMemory({ updateUi: true });
                    return 'Summaryception memory cleared and messages unghosted.';
                },
                helpString: 'Clear all Summaryception memory and unghost messages for this chat',
            }),
        );

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-preview',
                callback: () => {
                    return assembleSummaryBlock() || '(No summaries yet)';
                },
                helpString: 'Preview the summary block that would be injected',
            }),
        );
    } catch (e) {
        warn('Could not register slash commands:', e);
    }
}
