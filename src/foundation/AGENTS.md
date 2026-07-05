# Foundation Layer (Bottom Layer)

This directory contains globals, constants, state management, and retry utilities. It has no dependencies on higher layers (`core`, `features`, `entry`).

## SillyTavern Context Facade (CRITICAL)
- `src/foundation/context.js` is the **only module allowed** to touch the `SillyTavern` global (e.g., `SillyTavern.getContext()`).
- If you need to access SillyTavern's API (PromptManager, saveChat, executeSlashCommands, etc.) anywhere else in the codebase, you MUST export a safe wrapper from `context.js` and import it where needed.

## State Management
- Layer data lives in `chatMetadata[MODULE_NAME]`.
- Settings are cross-chat (`extensionSettings[MODULE_NAME]`).
- `getChatStore()` normalizes saved chat metadata.