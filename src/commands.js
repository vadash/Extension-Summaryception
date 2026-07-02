import { log } from './logger.js';
import { getChatStore } from './state.js';
import { assembleSummaryBlock } from './injection.js';
import { clearSummaryceptionMemory } from './memory.js';

// ─── Slash Commands ──────────────────────────────────────────────────

export function registerSlashCommands() {
    try {
        const ctx = SillyTavern.getContext();

        if (!ctx.SlashCommandParser?.addCommandObject || !ctx.SlashCommand) {
            log('SlashCommandParser not available, skipping command registration.');
            return;
        }

        const { SlashCommandParser, SlashCommand } = ctx;

        SlashCommandParser.addCommandObject(
            SlashCommand.fromProps({
                name: 'sc-status',
                callback: () => {
                    const store = getChatStore();
                    const lines = ['**Summaryception Status**'];
                    lines.push(`Summarized up to index: ${store.summarizedUpTo}`);
                    if (store.layers) {
                        for (let i = 0; i < store.layers.length; i++) {
                            const l = store.layers[i];
                            if (l && l.length > 0) {
                                lines.push(`Layer ${i}: ${l.length} snippets`);
                            }
                        }
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
        log('Could not register slash commands:', e);
    }
}
