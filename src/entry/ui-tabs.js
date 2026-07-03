const SETTINGS_TAB_STORAGE_KEY = 'summaryception.activeSettingsTab';

/**
 * Initialize settings tab navigation and restore the browser-session active tab.
 * @returns {void}
 */
export function initSettingsTabs() {
    const storedTab = getStoredSettingsTab();
    if (storedTab) {
        activateSettingsTab(storedTab);
    }

    $(document).on('click', '.sc-tab-button', function () {
        const tabName = String($(this).data('sc-tab') || '');
        if (!tabName) {
            return;
        }
        activateSettingsTab(tabName);
        storeSettingsTab(tabName);
    });
}

/**
 * Read the stored settings tab if it still exists in the current markup.
 * @returns {string}
 */
function getStoredSettingsTab() {
    try {
        const tabName = sessionStorage.getItem(SETTINGS_TAB_STORAGE_KEY) || '';
        return $(`.sc-tab-button[data-sc-tab="${tabName}"]`).length ? tabName : '';
    } catch (_e) {
        return '';
    }
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
        // Session storage can be unavailable in hardened browser contexts.
    }
}

/**
 * Activate a settings tab and hide the other tab panels.
 * @param {string} tabName
 * @returns {void}
 */
function activateSettingsTab(tabName) {
    const targetButton = $(`.sc-tab-button[data-sc-tab="${tabName}"]`);
    const targetPanel = $(`.sc-tab-panel[data-sc-panel="${tabName}"]`);
    if (!targetButton.length || !targetPanel.length) {
        return;
    }

    $('.sc-tab-button').removeClass('active').attr('aria-selected', 'false');
    targetButton.addClass('active').attr('aria-selected', 'true');
    $('.sc-tab-panel').removeClass('active').attr('hidden', true);
    targetPanel.addClass('active').removeAttr('hidden');
}
