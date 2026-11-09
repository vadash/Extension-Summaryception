# One owner for the connection-route set

Every connection route — Layer 0, the Layer 1+ merge override, the fallback, and the Auditor's own pair — is declared once in a foundation catalogue, and settings normalization, reset preservation, the UI bindings, panel-visibility sync, the Call Profile's provider settings, and both chain shapes derive from it, so a route's facts cannot disagree between the six modules that used to restate them.

## Considered Options

- **Discovering routes from key prefixes** — a naming convention doing a declaration's job: a non-route prefixed key leaks into the connection settings.
- **Letting `settings.html` be the declaration** — markup is unreadable to `foundation/settings.js`, so the normalizer would keep a second copy.
- **Folding the provider adapters in too** — rejected: the default and profile adapters genuinely vary, so that capability seam stays.
