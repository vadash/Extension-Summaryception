# Summarizer inputs fold braille masks and legacy $$ to spaces, always on

Every `U+2800` BRAILLE PATTERN BLANK and every legacy `$$` is folded to one `U+0020` in user and assistant content, Snippet prose, and checkpoint writes — after ST regex scripts, always on regardless of the mask setting — because leaked mask characters poison Snippets.

## Considered Options

- **Fold only when masking is on** — rejected: with masking off, pasted `U+2800` or `$$` reaches the summarizer.
