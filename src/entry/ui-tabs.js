const SETTINGS_TAB_STORAGE_KEY = 'summaryception.activeSettingsTab';

/**
 * Initialize settings tab navigation and start each page load on Status.
 * @returns {void}
 */
export function initSettingsTabs() {
    activateSettingsTab('status');
    activatePromptPane('layer0');

    $(document).on('click', '.sc-tab-button', function () {
        const tabName = String($(this).data('sc-tab') || '');
        if (!tabName) {
            return;
        }
        activateSettingsTab(tabName);
        storeSettingsTab(tabName);
    });

    $(document).on('click', '.sc-prompt-segment-button', function () {
        const paneName = String($(this).data('sc-prompt-tab') || '');
        if (!paneName) {
            return;
        }
        activatePromptPane(paneName);
    });
}

/**
 * Store the active settings tab for this browser session.
 * @param {string} tabName
 * @returns {void}
 */
function storeSettingsTab(tabName) {
    try {
        sessionStorage.setItem(SETTINGS_TAB_STORAGE_KEY, tabName);
    } catch (_e) {
        // Hardened browser contexts can block session storage.
    }
}

/**
 * Activate a button/panel group: mark the target active, hide the rest.
 * @param {{ buttonClass: string, buttonAttr: string, panelClass: string, panelAttr: string }} group
 * @param {string} name - Target tab or pane name
 * @returns {void}
 */
function activateTabGroup({ buttonClass, buttonAttr, panelClass, panelAttr }, name) {
    const targetButton = $(`${buttonClass}[data-${buttonAttr}="${name}"]`);
    const targetPanel = $(`${panelClass}[data-${panelAttr}="${name}"]`);
    if (!targetButton.length || !targetPanel.length) {
        return;
    }

    $(buttonClass).removeClass('active').attr('aria-selected', 'false');
    targetButton.addClass('active').attr('aria-selected', 'true');
    $(panelClass).removeClass('active').attr('hidden', true);
    targetPanel.addClass('active').removeAttr('hidden');
}

/**
 * Activate a settings tab and hide the other tab panels.
 * @param {string} tabName
 * @returns {void}
 */
function activateSettingsTab(tabName) {
    activateTabGroup(
        {
            buttonClass: '.sc-tab-button',
            buttonAttr: 'sc-tab',
            panelClass: '.sc-tab-panel',
            panelAttr: 'sc-panel',
        },
        tabName,
    );
}

/**
 * Activate an internal prompt editor pane.
 * @param {string} paneName
 * @returns {void}
 */
function activatePromptPane(paneName) {
    activateTabGroup(
        {
            buttonClass: '.sc-prompt-segment-button',
            buttonAttr: 'sc-prompt-tab',
            panelClass: '.sc-prompt-pane',
            panelAttr: 'sc-prompt-panel',
        },
        paneName,
    );
}
