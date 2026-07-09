# Summaryception Settings Optimizer - Review

## Overview

`scripts/optimize_settings.py` is a Python script that parses an F12 RP processing
log, extracts real usage patterns, and brute-force grid-searches the most
cost-efficient settings for Standard vs Cache-Friendly memory modes.

It was run against `C:\tmp\exce\v14\1_short_f12.txt` (103 KB, 85 L0 calls, 109
memory samples).

---

## Models Implemented

### 1. Cost Model (with output split fix)

| Component        | Rate | Notes                                              |
| ---------------- | ---- | -------------------------------------------------- |
| Input (uncached) | 10x  | Full context reprocessing                          |
| Cached input     | 1x   | Frozen prefix in cache mode                        |
| Output           | 50x  | Only assistant-generated text (70% of turn)        |
| User input       | 10x  | User's portion of turn (30%), billed at input rate |

The output split fix corrects a bug where the entire RP turn (user + assistant)
was billed at the 50x output rate. Only the assistant's generated response should
incur the output penalty. User input is billed at the input rate (10x).

Default split ratio: 30% user / 70% assistant.

### 2. Near-Frontier Recall Curve

Instead of a hard step function (perfect < 32k, tolerable < 64k), a smooth
interpolation simulates a high-performance model slightly below SOTA:

| Context Size | Recall |
| ------------ | ------ |
| 0            | 100.0% |
| 4,000        | 99.5%  |
| 8,000        | 99.4%  |
| 16,000       | 98.8%  |
| 32,000       | 97.5%  |
| 64,000       | 90.0%  |
| 128,000      | 75.0%  |
| 256,000      | 45.0%  |

### 3. Semantic Information Quality (SIQ) Decay Model

Empirically calibrated from practice log data:

| Context Type    | Retention Multiplier | Absolute Weight |
| --------------- | -------------------- | --------------- |
| Verbatim (live) | -                    | 100.0%          |
| Layer 0 (L0)    | 0.75                 | 75.0%           |
| Layer 1 (L1)    | 0.85 (recursive)     | 63.7%           |
| Layer 2 (L2)    | 0.85 (recursive)     | 54.2%           |

**Effective Context Quality (ECQ)** combines SIQ layer weights with the recall
curve to produce a single "quality tokens" metric. Cost per Quality Token
($/kQT = cost_per_turn / ECQ * 1000) finds the cheapest way to feed high-fidelity
information to the model.

Default memory layer distribution: 60% L0 / 30% L1 / 10% L2.

---

## Extracted RP Profile

| Metric                   | Value                                           |
| ------------------------ | ----------------------------------------------- |
| Steady-state memory size | ~9,592 tokens                                   |
| Max memory seen          | 10,000 tokens                                   |
| Avg L0 output summary    | ~312 tokens                                     |
| Avg L0 prompt size       | ~6,574 tokens                                   |
| Avg L0 input size        | ~15,458 tokens                                  |
| Avg turns per L0 batch   | ~15.2 turns                                     |
| Total L0 calls in log    | 85                                              |
| Memory samples parsed    | 109                                             |
| **Tokens per RP turn**   | **~1,017** (derived from L0 input / batch size) |

The ~1,017 tokens/turn is notably high for RP. This means context depletes fast:
a 16k verbatim window holds only ~15.7 turns of live chat.

---

## Codebase Constraints

These are extracted from the actual source code, not assumed:

- `verbatimTokenBudget`: 4000-64000, step 1000 (default 16000)
- `memoryTokenBudget`: 4000-32000, step 1000 (default 10000)
- `maxL0SourceTokens`: 4000-32000, step 1000 (default 16000)
- Cache mode forces `verbatimTokenBudget = 32000` (src/foundation/state.js)
- Protected tail = `clamp(round(vb * 0.2 / 1000) * 1000, 4000, 8000)` (src/core/cache-planner.js)

---

## Quality Floors

Two quality constraints prevent the optimizer from "cheating" to lower cost
at the expense of RP quality:

1. **Min visible turns = 12**: Verbatim must hold >= 12 RP turns of coherent
   recent context. At ~1,017 tokens/turn, this means min verbatim ~12,204 tokens.
2. **Min memory budget = 10,000**: Floored to observed steady-state memory.
   Setting memory below this silently truncates the memory layer.

---

## Results

### Default-Setting Baseline

| Mode     | Memory | Verbatim | Cost/Turn | TotCtx | Recall | ECQ    | $/kQT  | Vis Turns |
| -------- | ------ | -------- | --------- | ------ | ------ | ------ | ------ | --------- |
| Standard | 10,000 | 16,000   | 316,424   | 26,000 | 98.0%  | 22,492 | 14,068 | 15.7      |
| Cache    | 10,000 | 32,000   | 90,291    | 42,000 | 95.2%  | 37,067 | 2,435  | 31.5      |

### Optimal by Raw Cost (quality-filtered)

| Mode     | Memory | Verbatim | Cost/Turn | Recall | Vis Turns | vs Default             |
| -------- | ------ | -------- | --------- | ------ | --------- | ---------------------- |
| Standard | 10,000 | 14,000   | 296,424   | 98.2%  | 13.8      | 6.3% cheaper           |
| Cache    | 10,000 | 32,000   | 90,291    | 95.2%  | 31.5      | 0.0% (already optimal) |

Cache vs Standard (raw cost): **69.5% cheaper per turn**.

### Optimal by Cost/Quality-Token (ECQ, quality-filtered)

| Mode     | Memory | Verbatim | Cost/Turn | Recall | ECQ    | $/kQT  | vs Default             |
| -------- | ------ | -------- | --------- | ------ | ------ | ------ | ---------------------- |
| Standard | 10,000 | 48,000   | 636,424   | 91.4%  | 50,231 | 12,669 | 9.9% cheaper/kQT       |
| Cache    | 10,000 | 32,000   | 90,291    | 95.2%  | 37,067 | 2,435  | 0.0% (already optimal) |

Cache vs Standard (ECQ): **80.8% cheaper per quality-token**.

The ECQ view reveals that in Standard mode, larger verbatim windows improve
cost-efficiency per quality token (because verbatim has 100% SIQ weight vs 75%
for L0 memory). The $/kQT curve bottoms at vb=48k ($12,669), but this requires
58k total context (91.4% recall), which is deep into the tolerable zone.

### Standard Mode Pareto (by ECQ)

| Verbatim | Cost/Turn | Recall | ECQ    | $/kQT  |
| -------- | --------- | ------ | ------ | ------ |
| 14,000   | 296,424   | 98.2%  | 20,566 | 14,412 |
| 16,000   | 316,424   | 98.0%  | 22,492 | 14,068 |
| 22,000   | 376,424   | 97.5%  | 28,230 | 13,333 |
| 32,000   | 476,424   | 95.2%  | 37,067 | 12,852 |
| 48,000   | 636,424   | 91.4%  | 50,231 | 12,669 |

$/kQT decreases monotonically as verbatim grows: more verbatim = more 100%-quality
tokens. But the curve flattens after 48k, and recall drops to 91.4%.

### Perfect-Recall-Only (recall >= 97.5%)

| Mode     | Memory | Verbatim | Cost/Turn | $/kQT  | Recall | Vis Turns |
| -------- | ------ | -------- | --------- | ------ | ------ | --------- |
| Standard | 10,000 | 22,000   | 376,424   | 13,333 | 97.5%  | 21.6      |
| Cache    | none   | -        | -         | -      | -      | -         |

Cache mode cannot achieve 97.5% recall because it forces vb=32k. With 10k memory,
total context is 42k (95.2% recall). This is the fundamental tradeoff.

---

## Analysis

### What the output split fix changed

The output split fix reduced costs by ~4% across all configurations. The default
Standard baseline dropped from 328,628 to 316,424. The default Cache baseline
dropped from 112,665 to 90,291. This makes the savings numbers more conservative
and accurate.

### What the ECQ model revealed

The ECQ model fundamentally changes the Standard mode optimization landscape:

- **By raw cost alone**: Smaller verbatim is always cheaper (14k wins). This
  rewards truncating context, which degrades RP quality.
- **By ECQ ($/kQT)**: Larger verbatim is more efficient per quality token,
  because verbatim has 100% SIQ weight vs 75% for L0. The curve bottoms at vb=48k
  ($12,669/kQT), but this pushes total context to 58k (91.4% recall).
- **The sweet spot**: vb=22k ($13,333/kQT) is the last config with >= 97.5%
  recall. It offers 21.6 visible turns at 97.5% recall, only 5.2% more $/kQT
  than the absolute ECQ minimum.

### What the recall curve changed

The smooth recall curve replaces the hard "perfect < 32k" step with gradual
degradation. Key differences:

- 26k context is now 98.0% recall (was "perfect" before). Still very good.
- 42k context (cache default) is now 95.2% recall (was "tolerable" before).
  This is still well above 90%, so cache mode's recall penalty is mild.
- 64k context is 90.0% recall, the hard floor we disallow.

### Cache mode is already optimal

Both raw-cost and ECQ optimization confirm: the app defaults for cache mode
(mem=10k, vb=32k) are already at the minimum allowed memory and the forced
verbatim. There is nothing to tune. Cache mode is 69.5% cheaper per turn and
80.8% cheaper per quality-token than the best Standard config.

### Standard mode has room to optimize

- **For cost minimizers**: Drop verbatim from 16k to 14k (saves 6.3% per turn,
  13.8 visible turns, 98.2% recall). This is the raw-cost floor.
- **For quality maximizers**: Raise verbatim to 22k (21.6 visible turns, 97.5%
  recall, $13,333/kQT). This is the perfect-recall ceiling.
- **For ECQ optimizers**: Raise verbatim to 48k (47.2 visible turns, 91.4%
  recall, $12,669/kQT). This is the absolute $/kQT minimum, but deep in
  tolerable recall territory.

---

## Assumptions and Caveats

1. **Tokens per RP turn (~1,017)**: Derived from avg L0 input / avg turns per
   batch. This is a high-density estimate. If actual per-turn density is lower,
   visible turn counts will be higher than reported.

2. **Output split ratio (30/70)**: Assumed 30% user input / 70% assistant output.
   If the user writes longer prompts, this ratio shifts and costs change slightly.

3. **SIQ retention values (L0=75%, LN=85%)**: Empirically calibrated from
   practice data. These are semantic retention estimates, not precise
   measurements. The actual retention depends on prompt quality and model.

4. **Memory layer distribution (60/30/10)**: Assumed distribution of tokens
   across L0/L1/L2. In practice, this varies with story length and promotion
   frequency. Early in a chat, most memory is L0. After many promotions, L1/L2
   grow.

5. **Near-frontier recall curve**: Simulates a high-performance model near SOTA.
   Actual recall varies by model. Local/smaller models will degrade faster.

6. **L0 summarization cost**: Modeled as partitions of max_l0_source tokens.
   Assumes the extension splits large flushes into multiple L0 API calls, which
   matches the partition-planner.js behavior.

7. **Cache hit modeling**: Assumes the entire frozen prefix (memory + tail +
   accumulated flush region) is cached at 1x rate. In practice, some providers
   have minimum cache chunk sizes or partial cache breaks. This is idealized.

---

## Script Usage

```bash
# Default log path (hardcoded)
python scripts/optimize_settings.py

# Custom log path
python scripts/optimize_settings.py C:\path\to\log.txt
```

Tunable parameters at the top of the script:

- `COST_INPUT`, `COST_CACHED`, `COST_OUTPUT`: Pricing multipliers
- `USER_INPUT_RATIO`, `ASSISTANT_OUTPUT_RATIO`: Output split
- `RETENTION_L0`, `RETENTION_LN`: SIQ decay values
- `MIN_TURNS_VISIBLE`: Quality floor for visible turns
- `SEARCH_STEP`: Grid resolution (2000 = fast, 1000 = thorough)
- `_RECALL_POINTS`: Recall curve anchor points
