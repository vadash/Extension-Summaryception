# One owner for the connection-route set

Every connection route — the Layer 0 route, the Layer 1+ merge override, the fallback route, and the Auditor's own pair — is declared once in a foundation catalogue: its setting keys, the source options it accepts, the provider sources among them, the unset default, the key-to-provider-setting mapping the Call Profile resolves, and the UI slots its panels show. Settings normalization, reset preservation, the UI bindings, the panel-visibility sync, and the two chain shapes all derive from it, so a route's facts can no longer disagree between the six modules that used to restate them.

## Considered Options

- **Discovering routes from key prefixes** — a naming convention doing a declaration's job: a prefixed key that is not a route setting leaks into the connection settings object, and the Auditor routes had to bypass the mechanism entirely.
- **Letting `settings.html` be the declaration** — markup is unreadable to `foundation/state.js` and the Call Profile, so the normalizer would keep a second copy.
- **One module per route family** — five modules each holding a slice of one decision, which is the shape being replaced.
- **Folding the provider adapters in too** — rejected: the default and profile adapters genuinely vary, so that capability seam stays where it is.
