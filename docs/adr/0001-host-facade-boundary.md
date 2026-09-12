# Reach SillyTavern globals only through the foundation host facade

The extension runs inside the SillyTavern browser runtime, where the host API surface shifts between releases. All runtime globals are reached through one foundation host facade module instead of direct calls. Required host APIs target the current stable SillyTavern release; optional integrations (tokenizer, player name) return a safe fallback when unavailable. Direct global access was rejected because it would scatter breaking-change risk across every module and make the host dependency untestable.
