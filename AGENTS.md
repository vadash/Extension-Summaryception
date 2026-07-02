# Repository Guidelines

## Project Structure & Module Organization

This is a SillyTavern browser extension (no build step, no package manager). All files live at the repo root:

| File | Purpose |
|---|---|
| `index.js` | Core extension logic: summarization, layer promotion, ghosting, injection, settings UI |
| `connectionutil.js` | API routing layer: supports Default (generateRaw), Connection Profile, Ollama, and OpenAI-compatible backends |
| `settings.html` | Extension settings panel markup |
| `style.css` |Styles for the settings panel, snippet browser, catchup dialog, and prompt manager |
| `manifest.json` | Extension metadata (display name, version, entry points) |

The extension uses ES module syntax (`import`/`export`) and runs entirely in the browser via SillyTavern's extension system. There is no `package.json`, no bundler, and no test suite.

## Build, Test, and Development Commands

No build step. To develop:

```bash
cd SillyTavern/data/default-user/extensions/third-party/
git clone https://github.com/Lodactio/Extension-Summaryception
```

Then enable the extension in SillyTavern's UI. Changes to `index.js`, `connectionutil.js`, `settings.html`, or `style.css` take effect on browser reload.

There are no automated tests. Manual testing requires a running SillyTavern instance (1.16.0+) with an active LLM connection.

## Coding Style & Naming Conventions

- **Language**: Vanilla JavaScript (ES2022+, ES modules)
- **Naming**: camelCase for functions and variables, `SCREAMING_SNAKE_CASE` for constants (`MODULE_NAME`, `LOG_PREFIX`, `RETRY_CONFIG`), PascalCase for classes (`ConnectionError`)
- **Indentation**: 4 spaces
- **Strings**: Single quotes preferred
- **Functions**: `const fn = () => {}` for inline, `function name() {}` for hoisted/top-level
- **Prefix all console output** with `[Summaryception]` (stored in `LOG_PREFIX`)
- Linting (ESLint) and formatting (Prettier) are installed and enforced automatically. A pre-commit hook runs them on staged files; CI runs them on every PR.
- **Do NOT manually reformat or lint-fix code before committing.** Commit your changes raw, then fix lint/format failures in a follow-up commit. This keeps diffs focused on the actual change.

Key globals: `SillyTavern.getContext()`, `toastr` (notifications), `jQuery` (`$`) for DOM manipulation.

## Testing Guidelines

No testing framework exists. To verify changes:

1. Load the extension in SillyTavern with debug mode enabled (`debugMode: true` in settings)
2. Check browser console for `[Summaryception]` logs
3. Enable trace mode (`traceMode: true`) for detailed flow logs including entry/exit of all core functions
4. Test each connection source independently: Default, Ollama, OpenAI-compatible
5. Verify backlog detection, branch repair, and layer promotion with a chat containing 50+ messages

## Commit & Pull Request Guidelines

The project uses AGPL-3.0. Based on the git history and README:

- Keep commit messages concise and descriptive
- Do not commit unnecessary files; this is a lean extension with minimal surface area
- Pull requests should describe the user-facing behavior change
- Link related issues where applicable
- Avoid sweeping style changes that unrelated to the feature/fix

## Architecture Overview

The extension manages a recursive layer system stored in `chatMetadata[MODULE_NAME]`:

- **Layer 0** holds turn summaries (3 turns per snippet by default)
- **Layers 1+** hold meta-summaries promoted from the layer below
- **Verbatim turns** (most recent N assistant messages) are kept word-for-word
- **Ghosted messages** are hidden from LLM context via SillyTavern's `/hide` command but remain visible in the UI
- **Injection** uses `setExtensionPrompt()` to prepend the assembled summary block to LLM context
- **API calls** respect exponential backoff (up to 5 retries, 2s-60s delays) and disable all prompt toggles during summarizer calls to isolate the task from the user's writing preset

## Security & Configuration Tips

- API keys (Ollama, OpenAI-compatible) are stored in SillyTavern's `extensionSettings` object - do not log them
- The OpenAI endpoint supports local instances via ST's CORS proxy (`enableCorsProxy: true` in `config.yaml`)
- Passwords in `settings.html` should use `type="password"`
- Never expose user chat contents in error messages or logs beyond what debug mode already prints
