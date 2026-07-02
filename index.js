/**
 * Summaryception v5.5.3 - Layered Recursive Summarization for SillyTavern
 *
 * NON-DESTRUCTIVE: Uses SillyTavern's native /hide and /unhide commands
 * to exclude summarized messages from LLM context while keeping them
 * fully visible and readable in the chat UI.
 *
 * AGPL-3.0
 */

import { LOG_PREFIX } from './src/constants.js';
import { getSettings } from './src/state.js';
import { setUiUpdater } from './src/summarizer.js';
import { bindUIEvents, initConnectionUI, updateUI } from './src/ui.js';
import { updateInjection } from './src/injection.js';
import { onChatChanged, onGenerationStarted, onMessageReceived } from './src/events.js';
import { registerSlashCommands } from './src/commands.js';

(async function init() {
    const {
        eventSource,
        event_types,
        renderExtensionTemplateAsync,
    } = SillyTavern.getContext();

    getSettings();
    setUiUpdater(updateUI);

    const html = await renderExtensionTemplateAsync(
        'third-party/Extension-Summaryception',
        'settings',
        {}
    );
    $('#extensions_settings2').append(html);

    bindUIEvents();
    initConnectionUI();

    eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
    eventSource.on(event_types.CHAT_CHANGED, onChatChanged);
    eventSource.on(event_types.GENERATION_STARTED, onGenerationStarted);

    registerSlashCommands();

    eventSource.on(event_types.APP_READY, () => {
        updateInjection();
        updateUI();
        console.log(LOG_PREFIX, 'v5.5.3 loaded. Connection Settings available');
    });
})();
