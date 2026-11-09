# Summarizer inputs fold $$ to spaces, always on

Every literal `$$` is folded to one `U+0020` in user and assistant content, Snippet prose, and checkpoint writes — after ST regex scripts, always on regardless of the mask setting — because leaked `$$` poisons Snippets.

## Considered Options

- **Fold only when masking is on** — rejected: with masking off, pasted `$$` reaches the summarizer.
