# Run Control Gotchas

- One engine gate owns all automatic work.
- Route every automatic trigger through the queue and engine gate.
- Put automatic run guards in the gate.
- Stop persists a pause latch and lets the queue settle.
- Resume clears the latch and starts one cycle.
- Manual engine runs ignore the pause latch and enabled state.
- The stale-cache advice toast starts the same manual run as the Force Summarize button.
- Manual runs build their route plan inside the engine; callers pass run options only.
- UI handlers still block manual actions when the extension is disabled.
- Manual run callbacks and the abort signal pass as an explicit argument. Never carry them on the task object.
- A manual run needs a numeric target boundary. Reject the run when the route plan omits it.
- Automatic work must not mutate the prompt during generation.
- The app-ready signal fires before the chat and its metadata load. Wait for the chat-changed signal to read chat state.
- Loaded-chat reconciliation runs on every chat-changed signal: normalize keys, update injection, re-apply ghosting.
- Recover stale prompt freezes at the start of an automatic cycle.
