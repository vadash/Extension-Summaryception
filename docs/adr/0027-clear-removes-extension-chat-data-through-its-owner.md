# Clear removes every piece of Extension Chat Data through its owner

Clear removes all Extension Chat Data — the Chat Store, the stable message identifiers, the message token cache, and the Continuity Checkpoints — each shape removed by its writer, so no caller decides ownership by inspecting a key name. The Continuity Checkpoints go with the rest: ADR-0017 makes payload presence the Continuity State, so keeping them would leave a live state, its Continuity Marks, and its injected block in a chat whose narrative memory was just wiped.

## Considered Options

- **Identifying extension-owned message extras by the `sc_` key prefix** — a naming convention doing an ownership's job: the one key it missed, the Continuity Checkpoint, is the state.
- **Leaving the Continuity Checkpoints in place** — payload presence is the state (ADR-0017), but Clear's contract ends the chat as if the extension had never run.

## Consequences

A cleared chat cold-starts the Continuity Engine: the next audit begins from the default Continuity State (ADR-0017). A key no live module declares survives Clear forever, including an `sc_`-prefixed one; the prefix sweep is gone and there are no shims.
