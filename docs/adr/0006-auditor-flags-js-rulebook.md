# Auditor emits semantic flags; JavaScript owns the state rulebook

The Continuity Auditor emits only the five bond-pair booleans per Exchange; all counters, conversions, and thresholds are computed by JavaScript (ADR-0028 owns the derived `turn_count`). A language model doing the math was rejected: numeric drift compounds silently across rewrites, and boolean output is mechanically validatable.
