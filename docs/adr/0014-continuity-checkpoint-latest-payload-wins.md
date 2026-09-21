---
status: superseded by ADR-0017
---

# Continuity Checkpoint: payload in message extra, latest wins

Message-extra storage with latest-payload-wins, consolidating the Catch-up Window, Turn Count, and staleness rules. ADR-0017 restates the decision as one Continuity Coverage read model, correcting the reroll drop to the chat's last message and deriving the Continuity Block's placement from the prompt chat.
