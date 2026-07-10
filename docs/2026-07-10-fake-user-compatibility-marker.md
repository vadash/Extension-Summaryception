Yes. I recommend inserting one synthetic `user` block at the start only when masking would otherwise leave zero `user` roles, then masking all real text-only user messages as `assistant`.

Fake user block content:

```text
[user-role compatibility marker]
```

Why this content:
- It satisfies APIs that require at least one `user` role.
- It avoids revealing which real messages came from the user.
- It is intentionally not an instruction, so it is less likely to override system prompts, character prompts, or chat content.
- I would avoid text like `discard all previous instructions`, because that is itself a prompt injection and can break roleplay/context behavior unpredictably.

Implementation plan:
- Update `src/core/assistant-role-mask.js` so `Mask User Role` first checks whether the outgoing payload has any user messages that will remain after masking.
- If all real `user` messages are eligible for masking, prepend `{ role: 'user', content: '[user-role compatibility marker]' }` to the outgoing prompt/messages array.
- Rewrite all real text-only user messages to `assistant`, preserving current exclusions for multimodal/tool-adjacent messages.
- Avoid adding the marker when at least one non-maskable `user` message already remains.
- Add tests covering marker insertion, no duplicate marker when a real user remains, direct-array payloads, and existing disabled behavior.
- Run `npm test` after changes.