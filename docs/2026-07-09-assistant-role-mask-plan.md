# Assistant Role Mask Plan

## Summary

Add a default-off Advanced checkbox under `Strip CN` that rewrites final text-only chat-completion request blocks from `role: "user"` to `role: "assistant"` before SillyTavern sends the RP model request. The change is on-the-fly only: saved chat history, UI message roles, chat metadata, and summaries are not edited.

## Implementation

- Add `maskUserRoleAsAssistant: false` to extension settings and the typed settings surface.
- Add `Mask User Role` in the Advanced `Input Processing` section and bind it with the existing checkbox settings flow.
- Add help text explaining that the feature hides request roles only, does not remove names or prompt wording that identifies the user, and may be normalized or rejected by some providers.
- Add a pure core helper that mutates only final chat payload arrays:
  - convert text-only `role: "user"` messages to `role: "assistant"`;
  - leave `system`, `assistant`, `tool`, multimodal, and tool-adjacent blocks unchanged;
  - do not rewrite content or `name` fields.
- Register a `GENERATE_AFTER_DATA` handler from the extension entrypoint and apply the helper with `getEffectiveSettings()`, including dry-run payloads so prompt inspection matches live behavior.

## Tests

- Unit-test role conversion, disabled no-op behavior, multimodal/tool-adjacent skips, and defensive payload handling.
- Extend UI/settings tests for default, checkbox persistence, reset behavior, and help metadata.
- Extend event tests for `GENERATE_AFTER_DATA` integration.
- Run `npm test`.

## Assumptions

- First version targets chat-completion payloads only. Text-completion backends use flat strings and cannot meaningfully role-mask.
- The feature is Advanced-only in practice because Easy effective settings clone defaults, leaving the mask off.
- No SillyTavern source changes are needed for v1 because the existing `GENERATE_AFTER_DATA` event exposes the mutable generation payload.
