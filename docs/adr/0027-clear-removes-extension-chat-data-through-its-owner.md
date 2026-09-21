# Clear removes every piece of Extension Chat Data through its owner

Clear removes all Extension Chat Data — the Chat Store, the stable message identifiers, the message token cache, and the Continuity Checkpoints — and each shape is removed by the module that writes it, so no caller decides ownership by inspecting a key name. The Continuity Checkpoints go with the rest: ADR-0017 makes payload presence the Continuity State, so keeping them would leave a live state, its Continuity Marks, and its injected block in a chat whose narrative memory was just wiped.

## Considered Options

- **Identifying extension-owned message extras by the `sc_` key prefix** — a naming convention doing an ownership's job: the one live key it matched, the message token cache, self-heals on a text-length mismatch, while the one it missed, the Continuity Checkpoint, is the state — so the next payload could look cleaned while its ownership stayed undeclared.
- **Leaving the Continuity Checkpoints in place** — the defensible reading of ADR-0017 is that payload presence *is* the state, so a cleared chat keeps its state for the next audit. Rejected: Clear's contract is that the chat ends as if the extension had never run, and a half-cleared chat ships a scene block to a model with no narrative memory behind it.
- **Owners registering their removals into a registry** — rejected for a closed set of four with real ordering: the store and the Ghosting ownership go before the message payloads, and persistence goes last, so a registry would hide the order that makes the reset correct.
- **Deleting the chat-metadata key instead of emptying the store in place** — the deletion is transient, because `getChatStore()` recreates the key on read and every persist passes through it, and it forces the reset onto a second, hand-rolled write path beside the one writer.

## Consequences

A cleared chat cold-starts the Continuity Engine: the next audit begins from the default Continuity State, because payload presence is the state (ADR-0017). A key that no live module declares survives Clear forever, including one that happens to start with `sc_`: the prefix sweep is gone, and there are no migration shims.
