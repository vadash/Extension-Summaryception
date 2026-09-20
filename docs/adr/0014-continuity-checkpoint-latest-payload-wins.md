# Continuity Checkpoint: payload in message extra, latest wins

> Superseded by ADR-0017 (2026-09-20), which restates the decision as one
> Continuity Coverage read model. Kept message-extra storage with
> latest-payload-wins and consolidated the Catch-up Window, Turn Count, and
> staleness rules. ADR-0017 corrects the reroll drop to the chat's last message
> and derives the Continuity Block's placement from the prompt chat.
