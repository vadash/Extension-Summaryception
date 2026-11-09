# Microfiche spec handoff

Ready-to-implement handoff for the third Memory Mode, Microfiche. This document
is the canonical home for the handoff on the working branch (#55:118). The
tracker issue is the reviewable handoff; this document carries the same content
(#55:118). Part of #55; this ticket is #62. There are zero open decisions
(#54:32, #55:95-97).

Microfiche definition: the Chat Store, Snippet Commit, and Promotion stay
text-canonical exactly as today, and images render only at Memory Injection
time (#55:14-18). Older Snippets outside the Verbatim Window paginate into
glyph pages; the newest few stay as text (#55:18). Where the reader cannot
display images, the mode fails loud before spending any summarizer request and
never silently falls back to text (#55:18).

Public seam: `buildPromotionPlan`, `generateValidatedPromotion`,
`buildInjection`, `SummaryRoutePlan`. The mode label is not an input (#52:23,
#55:45-48).

## 1. Destination and preset

Destination is this file, `docs/specs/microfiche.md` (new `docs/specs/`
directory) (#54:30, #55:118). ADRs-only and a `docs/microfiche/` set were
rejected (#54:30).

Microfiche joins Balanced and Prefix Cache as a selectable mode with its own
preset (#55:45-48). The three selectable modes are `balanced`, `prefix_cache`,
and `microfiche`; `custom` carries no preset and is not selectable
(#55:45-48; `src/foundation/constants.js:64-100`).

The Microfiche preset carries Prefix-Cache-equal retention budgets, so a mode
switch changes the render path only and never retention (#55:45-48;
`src/foundation/constants.js:82-88`):

- `verbatimTokenBudget`: 20000
- `queuedTokenBudget`: 16000
- `atomicPartitions`: true

Settings reset preserves the mode and re-applies its preset; the read-time
normalizer accepts the new value and legacy values keep their existing mapping
(#55:47; `src/foundation/settings-normalizer.js:111-122`).

Route and partition selection moves off the mode label onto a preset
capability attribute (#55:48, #52:23). The Microfiche preset carries the
Prefix-Cache-equal capability, and the plan stays a pure function of settings:
identical preset inputs over an identical Chat Store yield an identical Route
Plan (#55:48). The mode label is not a Route Plan input (#55:17, #55:48).

Panels: both Easy and Advanced gain the third mode radio card (#55:24-25,
#55:73). Easy adds only the mode plus the keep-raw and image-cap sliders
(#55:73). All geometry knobs live in Advanced only, in a Microfiche section
following the existing Prefix-Cache TTL row pattern (#55:73).

## 2. Store-and-commit invariants

Text is canonical in the Chat Store, the Snippet Commit payload, and every
Promotion surface (quotas, merge outputs, drain) (#55:50-53). Microfiche never
alters a stored byte, a merge, or a drain decision (#55:52).

The Snippet Commit sequence (mutate, Ghosting ownership sync, Mutation Epoch
bump, persist, gated injection refresh) is unchanged, including its rollback
(#55:53). Ghosting ownership and the Continuity Engine are outside the parity
boundary and keep their own suites (#55:53, #52:25). The Continuity Engine is
named out of scope, not part of the parity bar (#52:25, #55:109).

The injection writer's text-only write gate stays untouched as the sole
slot-write gate and binary never enters it: a cache hit yields identical bytes
and identical marker text, so the key is unchanged, no slot rewrite happens,
and the prefix-cache hit is preserved (#55:85).

## 3. Settings keys

Every key carries type, bound, and default (#54:32, #55:55-70). Numeric bounds
declare once in the single-source slider-limits map
(`src/foundation/constants.js:311-340`); the read-time normalizer is the only
enforcement (#55:73). Bounds agreement with the settings template is pinned by
`tests/settings-bounds.test.js` (#55:103).

| Key | Type | Bound | Default | Meaning |
| --- | --- | --- | --- | --- |
| `microficheKeepRaw` | integer | 0-10 step 1 | 2 | newest-K Snippets kept as text; 0 means everything outside the Verbatim Window renders to images (#55:59, #55:26-27) |
| `microficheImageCap` | integer | 1-80 step 1 | 8 | images per injection; effective cap is min(slider, host image budget, preset budget); overflow stays text (#55:60, #55:28-29) |
| `microficheFont` | enum | `5x8`, `8x8`, `6x12`, `8x13`, `silver` | per-model winner | glyph font, 1:1 with the reference Shape set (#55:61) |
| `microficheCellWidth` | integer | 5-16 step 1 | per-model winner | glyph cell width (#55:62) |
| `microficheCellHeight` | integer | 6-22 step 1 | per-model winner | glyph cell height (#55:63) |
| `microficheStretch` | boolean | - | false | glyph stretch flag (#55:64) |
| `microficheVariant` | enum | `bw`, `sent` | `bw` | page variant (#55:65) |
| `microficheStopwordDim` | boolean | - | false | stopword dimming flag (#55:66) |
| `microficheColumns` | enum | `1`, `2` | `1` | page columns (#55:67) |
| `microficheLineRepeat` | integer | 1-2 step 1 | 1 | line repeat (#55:68) |
| `microficheFrameSize` | integer | 512-2608 step 8 | per-model winner | frame size (#55:69) |
| `microficheModelName` | text | - | empty | lookup box over the shipped shape database; shows top-3 shapes, click loads the custom starting point (#55:70) |
| `microficheGeometry` | enum | `gemini`, `deepseek`, `glm`, `custom` | `gemini` | named geometry preset selector; `custom` unlocks the explicit geometry controls (#55:72; `src/foundation/constants.js:207-251`) |

Code anchors: modes, presets, and applier at
`src/foundation/constants.js:64-122`; defaults and Microfiche knobs at
`src/foundation/constants.js:419-451`; geometry catalogue at
`src/foundation/constants.js:205-285`; slider bounds at
`src/foundation/constants.js:311-340`.

## 4. Injection-time render contract

Layout: oldest Snippets outside the Verbatim Window paginate to images in
chronological order; the newest-K (keep-raw) stay as text alongside the
verbatim tail (#55:75-77). The host prompt slot stays text-only end to end;
the injection carries text markers where pages belong, and a
completion-prompt-ready interceptor swaps each marker for its text plus image
parts at send time (#55:77).

Renderer: port of normalize, paginate, render, and PNG-cache glue as new
modules (#55:78). The port targets legibility parity on the probe corpus,
never byte-equal PNGs, and accepts the full reference variant key set with
the three preset defaults preferred (#55:78, #55:105). Font sources are three
BDF, one HEX, and one TTF, subject to a license check on the TTF before
vendoring (#55:78).

The Memory Injection read model keeps its build-once/measure-the-built-text
contract for the text half; image-token accounting extends the usage shape
without re-deriving layers (#55:79). Injection preview numbers reflect the
built injection, so preview and prompt agree (#55:36).

## 5. PNG cache contract

Per-page in-memory map keyed `epoch:textHash:shapeHash:pageIndex`, where the
text hash covers the built injection text, the shape hash covers the geometry
keys only, and the page index runs within the live cap (#55:81-84).
Set-level reuse falls out of per-page hits (#55:83).

Mutation Epoch drift drops all pages; text or geometry changes are plain key
misses; chat switch and reload kill the instance-held cache (#55:84). No
timer, no persistence, no byte accounting (#55:84). Entries cap at the live
image cap with LRU eviction inside one epoch; tab memory only (#55:84).

Repeated injections with unchanged memory reuse cached pages, so prefix-cache
hits survive and latency stays flat (#55:34). Any memory edit invalidates
cached pages automatically through the epoch bump, so an edited Snippet never
shows a stale image (#55:35).

## 6. Fail-loud pre-gate and vision gate

Hard gate is the host image-inlining capability plus a documented per-preset
reader list; no first-use readability probe (#55:87-89). Unsupported readers
abort with the existing red-notice path before the summarization cycle
prepares, after the prompt-work gate and enabled checks, so no request is
spent (#55:89, #55:33). Silent text fallback is rejected and stays rejected
(#55:89, #55:110).

## 7. Per-model presets and model-name lookup

Per-model presets replace any single shipped constant (#55:72):

- Gemini: `8on22-bw` at 2048 (#55:72; `src/foundation/constants.js:209-222`)
- DeepSeek: `8on22-bw` at 1568 (#55:72; `src/foundation/constants.js:223-235`)
- glm: `8on16-bw` at 1568 (#55:72; `src/foundation/constants.js:236-249`)

A preset selects variant plus frame size plus billing; custom unlocks the
explicit geometry controls: variant, frame size, columns, line-repeat, and
sent/bw controls (#55:72, #55:32). The model-name box types a model name and
shows its top-3 shapes; click loads the custom starting point (#55:30-32,
#55:70). The struck probe-rewrites-to-max-minus-1 formula and the
hand-rolled-geometry 40-page figure are dead and must not be implemented
(#55:72, #55:111).

Probe evidence and its reference-renderer correction live under
`docs/research/probe/` on throwaway branch `research/probe-microfiche`
(count-first sweep, 200-snippet frozen corpus, 80 blind questions strict-held
3/3) (#55:119). Headline reader results (#55:119-125):

| Reader | Geometry | Recall (strict 3/3) | Token coefficient vs text |
| --- | --- | --- | --- |
| Gemini class | 8on22-bw at 2048, 8 frames | 98.8% | 1 : 4.9 |
| DeepSeek class | 8on22-bw at 1568 | 92.0% in-frame | ~1 : 3.4 |
| glm class | 8on16-bw at 1568 | 63.9% in-frame | ~1 : 1.4 |

## 8. Mode-parity acceptance

> With every plan input held fixed — memoryTokenBudget, snippetsPerLayer, snippetsPerPromotion, injectionTemplate, and the preset's partition capability — over an identical Chat Store, memoryMode in {balanced, prefix_cache, microfiche} is not an input: buildPromotionPlan, generateValidatedPromotion output, buildInjection text and token cost, and SummaryRoutePlan are byte-identical. npm test and npm run lint stay green, and tests/mode-parity.test.js pins the invariant.

## 9. Verification list

Green gate is the whole-repo suite plus lint, both green; no named subset,
since a subset invites exactly the silent divergence the parity bar prevents
(#52:26, #55:104, #55:19). Run `npm test` and `npm run lint` (#62).

Required tests, all named by explicit path (#54:32, #55:95-103):

- `tests/mode-parity.test.js`: drives the four invariant surfaces (Promotion
  Plan, merge output, injection text plus token cost, Route Plan) with
  byte-identical inputs across all three selectable modes and asserts deep
  equality; no per-suite duplication, no golden fixture (#55:102, #52:25,
  #62).
- `tests/promotion-planner.test.js`: Promotion Planner pure-case suite (#55:103).
- `tests/promotion-candidate.test.js`: Promotion Candidate mock-dispatch suite
  (#55:103).
- `tests/memory-injection.test.js`: Memory Injection read-model suite (#55:103).
- `tests/summarization-routes.test.js`: summarization-routes mode matrix (today
  the only mode matrix, over the two existing modes) (#55:103).
- `tests/snippet-commit.test.js`: snippet-commit suite (#55:103).
- `tests/chat-window-planner.test.js`: chat-window planner suite (#55:103).
- `tests/partition-planner.test.js`: partition planner suite (#55:103).
- `tests/foreground-gate.test.js`: foreground-gate suite (#55:103).
- `tests/refresh.test.js`: refresh suite (#55:103).
- `tests/settings-bounds.test.js`: settings-bounds suite pinning rendered
  attributes to the slider-limits map (#55:103).

Renderer port proves legibility parity on the frozen probe corpus and
questions, rerun against the reference renderer evidence on the throwaway
probe branch; byte-equality with the reference PNGs is explicitly not asserted
(#55:105).
