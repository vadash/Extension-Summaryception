# Source router

- Foundation or cross-layer changes: read [architecture](../agent_docs/architecture/README.md).
- Summarization, state, connections, token planning, or ghosting: read [engine](../agent_docs/engine/README.md).
- Features, entry, `settings.html`, or `style.css`: read [UI and workflows](../agent_docs/ui/README.md).
- Lower layers never import higher layers. Only `foundation/context.js` accesses runtime `SillyTavern` global.
- Summary-layer or snippet mutations always bump mutation epoch.
