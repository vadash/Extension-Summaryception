# Auditor Character-Card Access

The Continuity Auditor does not receive the character card. `charDescription` / `charPersonality` are deliberately absent from the audit prompt's input blocks, and this will not change unless drift observations say otherwise.

## Why this is out of scope

The main use for card access would be canonical-name resolution: the auditor is told to spell bond keys exactly as the card does, but it cannot see the card. In practice the exposure is narrower than it looks — `<prior_continuity_state>` already carries card-spelled names as bond keys after a character's first audit, so the gap only bites on first appearance of a character.

Closing it means adding a `<character_lore>` block to every audit call: a permanent token cost on the most frequently fired prompt in the extension, paid to guard against a cosmetic, self-limiting failure. The existing machinery already contains the damage — a wrong-spelled key fails validation, triggers the one free section repair, and only becomes visible friction after a second consecutive drift, when the fail-safe freeze preserves the last good state instead of corrupting it.

Revisit this if audits start showing inflected or wrongly-spelled keys often enough to make the freeze path a regular occurrence. The fix shape is known: add the lore block next to the existing audit input blocks and update the rulebook, default prompt, and prompt tests together.

## Prior requests

- #31: "Auditor prompt lacks character-card access for canonical names"
