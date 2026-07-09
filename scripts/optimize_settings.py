#!/usr/bin/env python3
"""
Summaryception settings optimizer.

Reads an F12 RP processing log, extracts real usage patterns, then brute-force
grid-searches the most cost-efficient settings for Standard vs Cache-Friendly
memory modes.

Cost model:
    Input  = 10x
    Cached = 1x
    Output = 50x
    Only the assistant's generated text is billed at output rate (50x).
    User input is billed at input rate (10x). Default split: 30% user / 70% AI.

Quality model:
    - Near-Frontier Recall Curve: smooth interpolation simulating a high-performance
      model slightly below SOTA. Recall degrades gradually from 99.5% at 4k to
      90% at 64k, instead of a hard step function.
    - Semantic Information Quality (SIQ): empirically calibrated retention values
      from practice log data. L0 retains 75% of original semantic weight, each
      recursive L_n-1 -> L_n promotion retains 85%.
    - Effective Context Quality (ECQ): combines SIQ layer weights with recall curve
      to produce a single "quality tokens" metric. Cost/Quality-Token ($/kQT)
      finds the cheapest way to feed high-fidelity information to the model.

Codebase constraints (from src/foundation/constants.js + cache-planner.js):
    verbatimTokenBudget:  4000-64000, step 1000  (default 22000)
    memoryTokenBudget:    4000-32000, step 1000  (default 10000)
    maxL0SourceTokens:    4000-32000, step 1000  (default 16000)
    minSummaryBudget:     default 8000
    min/maxSummaryTurns:  3 / 8
    layer0SummaryTokenTarget: 200
    CACHE mode forces verbatimTokenBudget = 32000
    protectedTail = clamp(round(budget*0.2/1000)*1000, 4000, 8000)

Usage:
    python scripts/optimize_settings.py <path-to-log.txt>
    python scripts/optimize_settings.py            # uses default path below
"""

import re
import sys
import statistics
from dataclasses import dataclass, field

# ─── Configuration / Assumptions ─────────────────────────────────────

DEFAULT_LOG = r"C:\tmp\exce\v14\1_short_f12.txt"

COST_INPUT = 10
COST_CACHED = 1
COST_OUTPUT = 50

# Output split: only the assistant's generated text is billed at output rate.
# User input is billed at input rate. Typical RP ratio ~30% user / 70% assistant.
USER_INPUT_RATIO = 0.30
ASSISTANT_OUTPUT_RATIO = 0.70

RECALL_PERFECT = 32000
RECALL_TOLERABLE = 64000

# ─── Semantic Information Quality (SIQ) Decay Model ──────────────────
# Empirically calibrated from 1_long_f12.txt practice data:
#   L0 compresses ~15k tokens -> ~312 tokens (2% physical) but preserves
#   plot-critical details => 75% semantic retention.
#   L1->L2 promotion compresses dense summaries with high continuity => 85%.
RETENTION_L0 = 0.75  # CHAT -> L0 retention rate
RETENTION_LN = 0.85  # L_n-1 -> L_n recursive retention rate

# Codebase-derived setting ranges (step 1000 in UI; we search at 2000 resolution for speed)
VERBATIM_MIN, VERBATIM_MAX = 4000, 64000
MEMORY_MIN, MEMORY_MAX = 4000, 32000
L0_SOURCE_MIN, L0_SOURCE_MAX = 4000, 32000

SEARCH_STEP = 2000

# Quality floor: the live verbatim window must hold at least this many RP turns
# of coherent recent context, otherwise the model loses the thread of the scene.
MIN_TURNS_VISIBLE = 12

# Cache mode hardcodes this (src/foundation/state.js)
CACHE_FORCED_VERBATIM = 32000

# Default app settings (do NOT change; used as reference baseline)
APP_DEFAULTS = {
    "verbatimTokenBudget": 22000,
    "memoryTokenBudget": 10000,
    "maxL0SourceTokens": 16000,
    "minSummaryBudget": 8000,
    "minSummaryTurns": 3,
    "maxSummaryTurns": 8,
    "layer0SummaryTokenTarget": 200,
}


# ─── Log parsing ─────────────────────────────────────────────────────

def parse_num(val):
    """Convert '16k', '16.0k', '804', '1.2k' -> int."""
    s = str(val).strip().lower()
    if not s:
        return 0
    if s.endswith("k"):
        return int(float(s[:-1]) * 1000)
    try:
        return int(s)
    except ValueError:
        return int(float(s))


_L0_RE = re.compile(
    r"L0.*?\((\d+)\s*(?:assistant\s*)?turns?\).*?input\s+([\d.]+k?)"
    r".*?prompt\s+([\d.]+k?|\d+).*?output\s+(\d+)",
    re.IGNORECASE,
)
_L0_RE_ALT = re.compile(
    r"CHAT.*?L0.*?\((\d+)\s*(?:assistant\s*)?turns?\).*?output\s+(\d+)",
    re.IGNORECASE,
)
_MEM_RE = re.compile(r"Memory updated:.*?inject\s+([\d.]+k?|\d+)\s*tokens", re.IGNORECASE)
_MEM_RE_ALT = re.compile(r"memory.*?(\d[\d.]+k?)\s*tokens?", re.IGNORECASE)
_CTX_RE = re.compile(r"context.*?(\d[\d.]+k?)\s*tokens?", re.IGNORECASE)
_TURN_RE = re.compile(r"turn\s+(\d+)", re.IGNORECASE)


@dataclass
class LogProfile:
    l0_outputs: list = field(default_factory=list)
    l0_prompts: list = field(default_factory=list)
    l0_inputs: list = field(default_factory=list)
    turns_per_batch: list = field(default_factory=list)
    memory_sizes: list = field(default_factory=list)
    context_sizes: list = field(default_factory=list)
    total_turns: int = 0

    def summarize(self):
        def safe_mean(lst, default=0):
            return statistics.mean(lst) if lst else default

        # Steady-state memory = last 25% of observed updates
        steady_mem = self.memory_sizes[-max(1, len(self.memory_sizes) // 4):] if self.memory_sizes else [0]

        # Estimate tokens per RP turn from context growth if available,
        # otherwise from L0 input / turns ratio.
        avg_l0_output = safe_mean(self.l0_outputs, 300)
        avg_l0_prompt = safe_mean(self.l0_prompts, 5000)
        avg_l0_input = safe_mean(self.l0_inputs, 6000)
        avg_turns_batch = safe_mean(self.turns_per_batch, 8)

        return {
            "avg_l0_output": avg_l0_output,
            "avg_l0_prompt": avg_l0_prompt,
            "avg_l0_input": avg_l0_input,
            "avg_turns_per_batch": avg_turns_batch,
            "steady_memory_size": safe_mean(steady_mem),
            "max_memory_size": max(self.memory_sizes) if self.memory_sizes else 0,
            "max_context_size": max(self.context_sizes) if self.context_sizes else 0,
            "total_l0_calls": len(self.l0_outputs),
            "total_turns_seen": self.total_turns,
            "memory_samples": len(self.memory_sizes),
        }


def parse_log(filepath):
    prof = LogProfile()
    max_turn_seen = 0

    with open(filepath, "r", encoding="utf-8", errors="replace") as f:
        for line in f:
            m = _L0_RE.search(line)
            if m:
                prof.turns_per_batch.append(int(m.group(1)))
                prof.l0_inputs.append(parse_num(m.group(2)))
                prof.l0_prompts.append(parse_num(m.group(3)))
                prof.l0_outputs.append(parse_num(m.group(4)))
            else:
                m2 = _L0_RE_ALT.search(line)
                if m2:
                    prof.turns_per_batch.append(int(m2.group(1)))
                    prof.l0_outputs.append(parse_num(m2.group(2)))

            mm = _MEM_RE.search(line)
            if mm:
                prof.memory_sizes.append(parse_num(mm.group(1)))
            else:
                mm2 = _MEM_RE_ALT.search(line)
                if mm2:
                    prof.memory_sizes.append(parse_num(mm2.group(1)))

            mc = _CTX_RE.search(line)
            if mc:
                prof.context_sizes.append(parse_num(mc.group(1)))

            mt = _TURN_RE.search(line)
            if mt:
                t = int(mt.group(1))
                if t > max_turn_seen:
                    max_turn_seen = t

    prof.total_turns = max_turn_seen
    return prof


# ─── Cost model ──────────────────────────────────────────────────────

def protected_tail(verbatim_budget):
    """Replicates getProtectedTailTokens from cache-planner.js."""
    rounded = round(verbatim_budget * 0.2 / 1000) * 1000
    return min(8000, max(4000, rounded))


def l0_cost_per_flush(flush_tokens, memory_size, max_l0_source, avg_l0_output):
    """Total LLM cost to summarize a flush batch, split into partitions."""
    partitions = max(1, flush_tokens / max_l0_source)
    # Each partition prompt ~ memory + source chunk; output ~ avg_l0_output
    per_partition = (memory_size + min(flush_tokens, max_l0_source)) * COST_INPUT + avg_l0_output * COST_OUTPUT
    return partitions * per_partition


def standard_cost_per_turn(memory_size, verbatim_budget, tokens_per_turn,
                           max_l0_source, avg_l0_output, avg_turns_batch):
    """Standard mode: window slides every turn, no prefix cache."""
    ai_out = tokens_per_turn * ASSISTANT_OUTPUT_RATIO
    user_in = tokens_per_turn * USER_INPUT_RATIO
    # Chat cost: full context reprocessed at input rate + user input (input) + AI output (output)
    chat = (memory_size + verbatim_budget + user_in) * COST_INPUT + ai_out * COST_OUTPUT
    # Amortized L0 summarization: 1 batch every avg_turns_batch turns
    flush_tokens = avg_turns_batch * tokens_per_turn
    l0_per_turn = l0_cost_per_flush(flush_tokens, memory_size, max_l0_source, avg_l0_output) / avg_turns_batch
    return chat + l0_per_turn


def cache_cost_per_turn(memory_size, verbatim_budget, tokens_per_turn,
                        max_l0_source, avg_l0_output):
    """Cache mode: frozen prefix, periodic flush breaks cache once per cycle."""
    tail = protected_tail(verbatim_budget)
    flush_size = verbatim_budget - tail
    if flush_size <= 0 or tokens_per_turn <= 0:
        return float("inf")
    turns_per_cycle = flush_size / tokens_per_turn
    if turns_per_cycle < 1:
        return float("inf")

    ai_out = tokens_per_turn * ASSISTANT_OUTPUT_RATIO
    user_in = tokens_per_turn * USER_INPUT_RATIO

    # Turn 1 (flush / cache miss): full reprocess of memory + tail + user input
    turn1 = (memory_size + tail + user_in) * COST_INPUT + ai_out * COST_OUTPUT
    # Turns 2..N: cached prefix (avg) + user input (uncached) + AI output
    avg_cached_prefix = memory_size + tail + flush_size / 2
    cached_turn = avg_cached_prefix * COST_CACHED + user_in * COST_INPUT + ai_out * COST_OUTPUT
    total_chat = turn1 + cached_turn * (turns_per_cycle - 1)
    # L0 flush cost once per cycle
    total_l0 = l0_cost_per_flush(flush_size, memory_size, max_l0_source, avg_l0_output)
    return (total_chat + total_l0) / turns_per_cycle


# ─── Near-Frontier Recall Curve ──────────────────────────────────────

_RECALL_POINTS = [
    (0, 1.0), (4000, 0.995), (8000, 0.994), (16000, 0.988),
    (32000, 0.975), (64000, 0.900), (128000, 0.750), (256000, 0.450),
]


def get_near_frontier_recall(total_context):
    """Smooth interpolation simulating a high-performance model near SOTA frontier."""
    if total_context <= _RECALL_POINTS[0][0]:
        return _RECALL_POINTS[0][1]
    if total_context >= _RECALL_POINTS[-1][0]:
        return _RECALL_POINTS[-1][1]
    for i in range(len(_RECALL_POINTS) - 1):
        x0, y0 = _RECALL_POINTS[i]
        x1, y1 = _RECALL_POINTS[i + 1]
        if x0 <= total_context <= x1:
            return y0 + (y1 - y0) * (total_context - x0) / (x1 - x0)
    return 1.0


# ─── Effective Context Quality (ECQ) ────────────────────────────────

def calculate_ecq(verbatim_tokens, memory_tokens):
    """
    Effective Context Quality: total semantically-weighted information the model
    can actually recall, accounting for summarization decay and context-length
    recall degradation.
    """
    # Default memory layer distribution: 60% L0, 30% L1, 10% L2
    l0_tokens = memory_tokens * 0.60
    l1_tokens = memory_tokens * 0.30
    l2_tokens = memory_tokens * 0.10

    quality_verbatim = verbatim_tokens * 1.0
    quality_l0 = l0_tokens * RETENTION_L0
    quality_l1 = l1_tokens * (RETENTION_L0 * RETENTION_LN)
    quality_l2 = l2_tokens * (RETENTION_L0 * RETENTION_LN * RETENTION_LN)

    total_quality_tokens = quality_verbatim + quality_l0 + quality_l1 + quality_l2
    total_context_physical = verbatim_tokens + memory_tokens
    recall_rate = get_near_frontier_recall(total_context_physical)

    return total_quality_tokens * recall_rate


# ─── Grid search ─────────────────────────────────────────────────────

@dataclass
class Result:
    mode: str
    memory: int
    verbatim: int
    tail: int
    flush: int
    turns_per_cycle: float
    cost_per_turn: float
    total_context: int
    recall: str
    visible_turns: float = 0.0
    quality_ok: bool = False
    recall_pct: float = 1.0
    ecq: float = 0.0
    cost_per_quality: float = 0.0


def grid_search(stats, tokens_per_turn):
    results = []
    steady_mem = int(stats["steady_memory_size"]) or APP_DEFAULTS["memoryTokenBudget"]
    avg_l0_output = stats["avg_l0_output"] or 300
    avg_turns_batch = stats["avg_turns_per_batch"] or 8

    max_l0_source = APP_DEFAULTS["maxL0SourceTokens"]

    memory_candidates = set()
    memory_candidates.add(steady_mem)
    for m in range(MEMORY_MIN, min(steady_mem * 2 + 1, MEMORY_MAX) + 1, SEARCH_STEP):
        memory_candidates.add(m)
    memory_candidates = sorted(memory_candidates)

    min_visible_tokens = MIN_TURNS_VISIBLE * tokens_per_turn
    # Memory budget must not fall below observed steady-state memory, otherwise the
    # memory layer is silently truncated and the model loses long-term recall quality.
    min_memory_budget = max(MEMORY_MIN, ((steady_mem + 999) // 1000) * 1000)

    # ── Standard mode: search verbatim + memory ──
    for mem in memory_candidates:
        for vb in range(VERBATIM_MIN, VERBATIM_MAX + 1, SEARCH_STEP):
            total_ctx = mem + vb
            if total_ctx > RECALL_TOLERABLE:
                continue
            recall = "perfect" if total_ctx <= RECALL_PERFECT else "tolerable"
            tail = protected_tail(vb)
            flush = vb - tail
            c = standard_cost_per_turn(mem, vb, tokens_per_turn,
                                       max_l0_source, avg_l0_output, avg_turns_batch)
            vis = vb / tokens_per_turn if tokens_per_turn > 0 else 0
            qok = vb >= min_visible_tokens and mem >= min_memory_budget
            recall_pct = get_near_frontier_recall(total_ctx)
            ecq = calculate_ecq(vb, mem)
            cpq = (c / ecq * 1000) if ecq > 0 else float("inf")
            results.append(Result("standard", mem, vb, tail, flush, 0.0, c, total_ctx,
                                  recall, vis, qok, recall_pct, ecq, cpq))

    # ── Cache mode: verbatim fixed at 32000, search memory ──
    vb = CACHE_FORCED_VERBATIM
    for mem in memory_candidates:
        total_ctx = mem + vb
        if total_ctx > RECALL_TOLERABLE:
            continue
        recall = "perfect" if total_ctx <= RECALL_PERFECT else "tolerable"
        tail = protected_tail(vb)
        flush = vb - tail
        c = cache_cost_per_turn(mem, vb, tokens_per_turn, max_l0_source, avg_l0_output)
        tpc = flush / tokens_per_turn if tokens_per_turn > 0 else 0
        vis = vb / tokens_per_turn if tokens_per_turn > 0 else 0
        qok = vb >= min_visible_tokens and mem >= min_memory_budget
        recall_pct = get_near_frontier_recall(total_ctx)
        ecq = calculate_ecq(vb, mem)
        cpq = (c / ecq * 1000) if ecq > 0 else float("inf")
        results.append(Result("cache", mem, vb, tail, flush, tpc, c, total_ctx,
                              recall, vis, qok, recall_pct, ecq, cpq))

    return results


# ─── Reporting ───────────────────────────────────────────────────────

def fmt(n):
    return f"{int(n):,}"


def print_report(stats, tokens_per_turn, results):
    print("=" * 100)
    print(" SUMMARYCEPTION SETTINGS OPTIMIZER")
    print("=" * 100)

    print("\n--- EXTRACTED RP PROFILE ---")
    print(f"  Steady-state memory size : ~{fmt(stats['steady_memory_size'])} tokens")
    print(f"  Max memory seen          :  {fmt(stats['max_memory_size'])} tokens")
    print(f"  Max context seen         :  {fmt(stats['max_context_size'])} tokens")
    print(f"  Avg L0 output summary    : ~{fmt(stats['avg_l0_output'])} tokens")
    print(f"  Avg L0 prompt size       : ~{fmt(stats['avg_l0_prompt'])} tokens")
    print(f"  Avg L0 input size        : ~{fmt(stats['avg_l0_input'])} tokens")
    print(f"  Avg turns per L0 batch   : ~{stats['avg_turns_per_batch']:.1f} turns")
    print(f"  Total L0 calls in log    :  {stats['total_l0_calls']}")
    print(f"  Total turns seen in log  :  {stats['total_turns_seen']}")
    print(f"  Memory samples parsed    :  {stats['memory_samples']}")

    print(f"\n--- ASSUMPTIONS ---")
    print(f"  Cost model          : input={COST_INPUT}x  cached={COST_CACHED}x  output={COST_OUTPUT}x")
    print(f"  Output split        : user={USER_INPUT_RATIO:.0%} (input rate)  assistant={ASSISTANT_OUTPUT_RATIO:.0%} (output rate)")
    print(f"  Recall curve        : near-frontier smooth interpolation (see table below)")
    print(f"  SIQ retention       : L0={RETENTION_L0:.0%}  L_n-1->L_n={RETENTION_LN:.0%}")
    print(f"  Memory layer dist   : 60% L0 / 30% L1 / 10% L2")
    print(f"  Tokens per RP turn  : ~{fmt(tokens_per_turn)}  (derived from log)")
    print(f"  Min visible turns   : {MIN_TURNS_VISIBLE}  (=> min verbatim ~{fmt(MIN_TURNS_VISIBLE * tokens_per_turn)} tokens)")
    min_mem = max(MEMORY_MIN, ((int(stats['steady_memory_size']) + 999) // 1000) * 1000)
    print(f"  Min memory budget   : {fmt(min_mem)}  (>= steady-state memory, no silent truncation)")
    print(f"  Cache forced verbatim: {fmt(CACHE_FORCED_VERBATIM)} (codebase)")
    print(f"  Protected tail fn   : clamp(round(vb*0.2/1000)*1000, 4000, 8000)")

    # Print recall curve reference table
    print(f"\n--- NEAR-FRONTIER RECALL CURVE ---")
    print(f"  {'Context':>10}  {'Recall':>8}")
    for ctx_val, recall_val in _RECALL_POINTS:
        print(f"  {fmt(ctx_val):>10}  {recall_val:>7.1%}")

    # Print SIQ layer weights
    print(f"\n--- SEMANTIC INFORMATION QUALITY (SIQ) LAYER WEIGHTS ---")
    l0_w = RETENTION_L0
    l1_w = RETENTION_L0 * RETENTION_LN
    l2_w = RETENTION_L0 * RETENTION_LN * RETENTION_LN
    print(f"  Verbatim (live)  : 100.0%")
    print(f"  Layer 0 (L0)     : {l0_w:.1%}")
    print(f"  Layer 1 (L1)     : {l1_w:.1%}")
    print(f"  Layer 2 (L2)     : {l2_w:.1%}")

    print(f"\n--- APP DEFAULTS (reference, unchanged) ---")
    for k, v in APP_DEFAULTS.items():
        print(f"  {k:<28} = {v}")

    std = [r for r in results if r.mode == "standard"]
    cache = [r for r in results if r.mode == "cache"]

    std_sorted = sorted(std, key=lambda r: r.cost_per_turn)
    cache_sorted = sorted(cache, key=lambda r: r.cost_per_turn)

    # Also sort by cost-per-quality-token (ECQ-optimized)
    std_ecq_sorted = sorted(std, key=lambda r: r.cost_per_quality)
    cache_ecq_sorted = sorted(cache, key=lambda r: r.cost_per_quality)

    def print_table(title, rows, limit=12):
        print(f"\n--- {title} ---")
        hdr = (f"{'Rk':<4}{'Memory':>8}{'Verbatim':>10}{'Tail':>7}{'Flush':>8}"
               f"{'VisTrn':>7}{'Trn/Cyc':>8}{'Cost/Trn':>11}{'TotCtx':>9}"
               f"{'Recall%':>8}{'ECQ':>9}{'$/kQT':>9}{'Q':>3}")
        print(hdr)
        print("-" * len(hdr))
        for i, r in enumerate(rows[:limit], 1):
            q = "Y" if r.quality_ok else "n"
            print(f"{i:<4}{fmt(r.memory):>8}{fmt(r.verbatim):>10}{fmt(r.tail):>7}"
                  f"{fmt(r.flush):>8}{r.visible_turns:>7.1f}{r.turns_per_cycle:>8.1f}"
                  f"{fmt(r.cost_per_turn):>11}{fmt(r.total_context):>9}"
                  f"{r.recall_pct:>7.1%}{fmt(r.ecq):>9}{fmt(r.cost_per_quality):>9}{q:>3}")

    print_table("TOP STANDARD MODE BY RAW COST (cheapest first)", std_sorted)
    print_table("TOP CACHE MODE BY RAW COST (cheapest first)", cache_sorted)
    print_table("TOP STANDARD MODE BY COST/QUALITY-TOKEN (ECQ-optimized)", std_ecq_sorted)
    print_table("TOP CACHE MODE BY COST/QUALITY-TOKEN (ECQ-optimized)", cache_ecq_sorted)

    # Quality-filtered (meets min visible turns)
    std_q = [r for r in std_sorted if r.quality_ok]
    cache_q = [r for r in cache_sorted if r.quality_ok]
    std_q_ecq = [r for r in std_ecq_sorted if r.quality_ok]
    cache_q_ecq = [r for r in cache_ecq_sorted if r.quality_ok]
    print_table("STANDARD MODE - QUALITY-FILTERED BY RAW COST", std_q)
    print_table("CACHE MODE - QUALITY-FILTERED BY RAW COST", cache_q)
    print_table("STANDARD MODE - QUALITY-FILTERED BY COST/QUALITY-TOKEN", std_q_ecq)
    print_table("CACHE MODE - QUALITY-FILTERED BY COST/QUALITY-TOKEN", cache_q_ecq)

    # Default baseline costs
    def find(results, mem, vb):
        for r in results:
            if r.memory == mem and r.verbatim == vb:
                return r
        return None

    base_std = find(std, APP_DEFAULTS["memoryTokenBudget"], APP_DEFAULTS["verbatimTokenBudget"])
    base_cache = find(cache, APP_DEFAULTS["memoryTokenBudget"], CACHE_FORCED_VERBATIM)

    print(f"\n--- DEFAULT-SETTING BASELINE ---")
    if base_std:
        default_vb_label = f"{APP_DEFAULTS['verbatimTokenBudget'] // 1000}k"
        print(f"  Standard (mem=10k, vb={default_vb_label}): cost/turn={fmt(base_std.cost_per_turn)}  "
              f"totctx={fmt(base_std.total_context)} recall={base_std.recall_pct:.1%}  "
              f"ECQ={fmt(base_std.ecq)}  $/kQT={fmt(base_std.cost_per_quality)}  vis={base_std.visible_turns:.1f}trn")
    if base_cache:
        print(f"  Cache    (mem=10k, vb=32k): cost/turn={fmt(base_cache.cost_per_turn)}  "
              f"totctx={fmt(base_cache.total_context)} recall={base_cache.recall_pct:.1%}  "
              f"ECQ={fmt(base_cache.ecq)}  $/kQT={fmt(base_cache.cost_per_quality)}  vis={base_cache.visible_turns:.1f}trn")

    # Best overall (quality-filtered) - by raw cost AND by ECQ
    best_std = std_q[0] if std_q else std_sorted[0]
    best_cache = cache_q[0] if cache_q else cache_sorted[0]
    best_std_ecq = std_q_ecq[0] if std_q_ecq else std_ecq_sorted[0]
    best_cache_ecq = cache_q_ecq[0] if cache_q_ecq else cache_ecq_sorted[0]

    print(f"\n--- OPTIMAL FINDINGS BY RAW COST (quality-filtered) ---")
    print(f"  Best STANDARD : mem={fmt(best_std.memory)}  vb={fmt(best_std.verbatim)}  "
          f"tail={fmt(best_std.tail)}  flush={fmt(best_std.flush)}  "
          f"vis={best_std.visible_turns:.1f}trn  recall={best_std.recall_pct:.1%}  "
          f"cost/turn={fmt(best_std.cost_per_turn)}  totctx={fmt(best_std.total_context)}")
    print(f"  Best CACHE    : mem={fmt(best_cache.memory)}  vb={fmt(best_cache.verbatim)}  "
          f"tail={fmt(best_cache.tail)}  flush={fmt(best_cache.flush)}  "
          f"vis={best_cache.visible_turns:.1f}trn  turns/cycle={best_cache.turns_per_cycle:.1f}  "
          f"recall={best_cache.recall_pct:.1%}  cost/turn={fmt(best_cache.cost_per_turn)}  "
          f"totctx={fmt(best_cache.total_context)}")

    print(f"\n--- OPTIMAL FINDINGS BY COST/QUALITY-TOKEN (ECQ, quality-filtered) ---")
    print(f"  Best STANDARD : mem={fmt(best_std_ecq.memory)}  vb={fmt(best_std_ecq.verbatim)}  "
          f"tail={fmt(best_std_ecq.tail)}  flush={fmt(best_std_ecq.flush)}  "
          f"vis={best_std_ecq.visible_turns:.1f}trn  recall={best_std_ecq.recall_pct:.1%}  "
          f"cost/turn={fmt(best_std_ecq.cost_per_turn)}  ECQ={fmt(best_std_ecq.ecq)}  "
          f"$/kQT={fmt(best_std_ecq.cost_per_quality)}  totctx={fmt(best_std_ecq.total_context)}")
    print(f"  Best CACHE    : mem={fmt(best_cache_ecq.memory)}  vb={fmt(best_cache_ecq.verbatim)}  "
          f"tail={fmt(best_cache_ecq.tail)}  flush={fmt(best_cache_ecq.flush)}  "
          f"vis={best_cache_ecq.visible_turns:.1f}trn  turns/cycle={best_cache_ecq.turns_per_cycle:.1f}  "
          f"recall={best_cache_ecq.recall_pct:.1%}  cost/turn={fmt(best_cache_ecq.cost_per_turn)}  "
          f"ECQ={fmt(best_cache_ecq.ecq)}  $/kQT={fmt(best_cache_ecq.cost_per_quality)}  "
          f"totctx={fmt(best_cache_ecq.total_context)}")

    if base_std and best_std:
        sav = (1 - best_std.cost_per_turn / base_std.cost_per_turn) * 100
        print(f"\n  Standard raw-cost optimal vs default : {sav:.1f}% cheaper per turn")
    if base_cache and best_cache:
        sav = (1 - best_cache.cost_per_turn / base_cache.cost_per_turn) * 100
        print(f"  Cache raw-cost optimal vs default     : {sav:.1f}% cheaper per turn")
    if best_std and best_cache:
        sav = (1 - best_cache.cost_per_turn / best_std.cost_per_turn) * 100
        print(f"  Cache vs Standard (raw-cost best)      : {sav:.1f}% cheaper per turn")
    if base_std and best_std_ecq:
        sav = (1 - best_std_ecq.cost_per_quality / base_std.cost_per_quality) * 100
        print(f"  Standard ECQ-optimal vs default       : {sav:.1f}% cheaper per quality-token")
    if base_cache and best_cache_ecq:
        sav = (1 - best_cache_ecq.cost_per_quality / base_cache.cost_per_quality) * 100
        print(f"  Cache ECQ-optimal vs default          : {sav:.1f}% cheaper per quality-token")
    if best_std_ecq and best_cache_ecq:
        sav = (1 - best_cache_ecq.cost_per_quality / best_std_ecq.cost_per_quality) * 100
        print(f"  Cache vs Standard (ECQ best)           : {sav:.1f}% cheaper per quality-token")

    # Pareto: cheapest memory for each verbatim tier (standard, quality-filtered) - by ECQ
    print(f"\n--- STANDARD MODE PARETO (best memory per verbatim tier, quality-filtered, by ECQ) ---")
    print(f"{'Verbatim':>10}{'BestMem':>9}{'Tail':>7}{'VisTrn':>7}{'Cost/Trn':>11}"
          f"{'TotCtx':>9}{'Recall%':>8}{'ECQ':>9}{'$/kQT':>9}")
    print("-" * 79)
    for vb in range(VERBATIM_MIN, VERBATIM_MAX + 1, SEARCH_STEP):
        tier = [r for r in std_q if r.verbatim == vb]
        if not tier:
            continue
        r = min(tier, key=lambda x: x.cost_per_quality)
        print(f"{fmt(vb):>10}{fmt(r.memory):>9}{fmt(r.tail):>7}{r.visible_turns:>7.1f}"
              f"{fmt(r.cost_per_turn):>11}{fmt(r.total_context):>9}"
              f"{r.recall_pct:>7.1%}{fmt(r.ecq):>9}{fmt(r.cost_per_quality):>9}")

    # Perfect-recall-only filter (recall >= 97.5%)
    PERFECT_THRESHOLD = 0.975
    std_perf = [r for r in std_q if r.recall_pct >= PERFECT_THRESHOLD]
    cache_perf = [r for r in cache_q if r.recall_pct >= PERFECT_THRESHOLD]
    print(f"\n--- PERFECT-RECALL-ONLY (recall >= {PERFECT_THRESHOLD:.1%}) ---")
    if std_perf:
        r = sorted(std_perf, key=lambda x: x.cost_per_quality)[0]
        print(f"  Best STANDARD : mem={fmt(r.memory)}  vb={fmt(r.verbatim)}  "
              f"cost/turn={fmt(r.cost_per_turn)}  $/kQT={fmt(r.cost_per_quality)}  "
              f"recall={r.recall_pct:.1%}  vis={r.visible_turns:.1f}trn")
    else:
        print(f"  Standard: no quality config meets {PERFECT_THRESHOLD:.1%} recall")
    if cache_perf:
        r = sorted(cache_perf, key=lambda x: x.cost_per_quality)[0]
        print(f"  Best CACHE    : mem={fmt(r.memory)}  vb={fmt(r.verbatim)}  "
              f"cost/turn={fmt(r.cost_per_turn)}  $/kQT={fmt(r.cost_per_quality)}  "
              f"recall={r.recall_pct:.1%}")
    else:
        print(f"  Cache: none (cache forces vb=32k, so mem must be ~0 for perfect recall)")

    print("\n" + "=" * 100)


def main():
    filepath = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_LOG
    print(f"Parsing log: {filepath}")
    prof = parse_log(filepath)
    stats = prof.summarize()

    # Derive tokens-per-turn from L0 input / turns-per-batch if available,
    # else fallback to a reasonable RP estimate.
    if stats["avg_l0_input"] > 0 and stats["avg_turns_per_batch"] > 0:
        tokens_per_turn = stats["avg_l0_input"] / stats["avg_turns_per_batch"]
    else:
        tokens_per_turn = 400  # fallback assumption

    tokens_per_turn = max(50, tokens_per_turn)

    results = grid_search(stats, tokens_per_turn)
    print_report(stats, tokens_per_turn, results)


if __name__ == "__main__":
    main()
