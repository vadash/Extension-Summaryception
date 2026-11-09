# Summarizer inputs fold $$ to spaces, always on

Pasted or echoed `$$` would otherwise leak into Passage text, Memory Body, Auditor input, and Continuity Checkpoints and poison stored Snippets; the extension therefore folds every literal `$$` to one `U+0020` in user and assistant content, Snippet prose, and checkpoint writes after ST regex scripts and before hygiene, always on regardless of the mask settings, because the summarizer family must read normal words and the setting-independent leak exists whether masking is enabled or not.

## Considered Options

- **Fold only when masking is on** — rejected: pasted `$$` reaches the summarizer with masking off, so gating leaves the leak open.
