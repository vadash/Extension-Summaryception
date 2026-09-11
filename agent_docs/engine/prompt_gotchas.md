# Prompt Gotchas

- Prompt sections have a fixed order: input, schema, task rules, critical rules, trigger.
- The bare imperative trigger is the final prompt line.
- Insert dynamic budget and repair blocks above the trigger.
- Budget hints use countable units such as sentences and lines.
- State schema content follows enabled state categories.
- Keep token limits out of state category definitions.
- Strip configured output patterns before parsing.
- Dry runs may mark the payload or a separate argument.
- Ignore both dry-run forms before updating comparison state.
- Report one contiguous-prefix verdict for each real request.
- A broken-prefix report includes the complete first changed block.
- Treat only an explicit system flag as a system message.
- Replace every placeholder occurrence. Custom user templates may repeat a placeholder.
- Start a substituted schema block on its own line. Never concatenate it to instruction text.
- Keep structural header patterns in the shared header module. Do not define local copies.
- Section extraction rules differ by caller. One rule requires both headers; another requires only the state header.
- Keep call-label and token-range formatting in one module. Prompt logs and usage lines share them.
- Prompt preset keys and setting keys pair in one shared table. Add a new prompt field there only; both consumers derive from it.
