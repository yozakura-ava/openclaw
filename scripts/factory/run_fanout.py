#!/usr/bin/env python3
"""Fan-out runner — XAUUSD wave 1 (card 323564c1, sprint 2026-10-26 phase 2).

template grid → per-candidate cost-aware walk-forward (validated engine +
restored slippage fill model, REPLACE semantics) → confidence scoring.
One JSON artifact per candidate + a run summary.  Resumable: finished
candidates are skipped, interrupted ones re-run.  CPU-only, no GPU, no
TTY dependency (detached-safe).

Council amendment (card 323564c1) compliance:
  * admission fail-loud: any (symbol, TF) whose bar depth misses the
    card-a0165343 rule is SKIPPED with a loud artifact + log line;
  * OOS holdout windows are FROZEN in ``run_config.json`` before the first
    candidate runs; the wave aborts fail-loud if frozen inputs drift;
  * ONE spread source: ``data/spreads/xauusd_spread_stats.json`` per-TF p90,
    floored by the provisional bootstrap (``confidence.gates.
    PROVISIONAL_SYMBOL_TF_SPREADS``) feeds BOTH the SpreadGate context and
    the cost model (walk-forward spread + confidence spread);
  * pilot timing doubles as the cost-model sanity check (per-candidate
    ``cost_model.applied`` + trades costed are recorded).

Usage (repo root, node or gateway):
  PYTHONPATH=src .venv/bin/python scripts/factory/run_fanout.py \
      --pilot 5 --out-dir data/bqes2/2026-10-26-strategy-production/candidates
  PYTHONPATH=src .venv/bin/python scripts/factory/run_fanout.py \
      --out-dir data/bqes2/2026-10-26-strategy-production/candidates   # full wave
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import time
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

_REPO_ROOT = Path(__file__).resolve().parents[2]
for _p in (str(_REPO_ROOT / "src" / "forex_bot"), str(_REPO_ROOT / "src")):
    if _p not in sys.path:
        sys.path.insert(0, _p)

from backtest.data_loader import CsvDataLoader  # noqa: E402
from backtest.fill_model import SlippageConfig  # noqa: E402
from backtest.types import MarketState, determine_session  # noqa: E402
from backtest.walk_forward_runner import run_strategy_walk_forward  # noqa: E402
from confidence.engine import ConfidenceEngine  # noqa: E402
from confidence.gates import PROVISIONAL_SYMBOL_TF_SPREADS  # noqa: E402
from quant.walk_forward import _trades_per_year_from_bars  # noqa: E402

from forex_bot.factory.hygiene_triage import ENGINE_ARTIFACT_ABS_SR  # noqa: E402
from forex_bot.factory.templates.catalog import ADMISSION_MIN_BARS, FAMILY_GRIDS  # noqa: E402
from forex_bot.factory.templates.catalog_wave5 import FAMILY_GRIDS_WAVE5  # noqa: E402

#: Wave-5 confluence families extend the family lookup (additive; the
#: canonical grid artifact and its council band are unchanged).
FAMILY_GRIDS_ALL = {**FAMILY_GRIDS, **FAMILY_GRIDS_WAVE5}
from forex_bot.factory.templates.indicators import (  # noqa: E402
    FEATURE_KEYS,
    compute_feature_vector,
    infer_tf_minutes,
)

CARD = "323564c1-752e-4bb6-a12f-b50e28e34348"
SPRINT = "2026-10-26-strategy-production"
SYMBOL = "XAUUSD"
DEFAULT_GRID = "data/factory/template_grid_v1.json"
DEFAULT_DATA_DIR = "data/exports/market_bars"
DEFAULT_STATS = "data/spreads/xauusd_spread_stats.json"
CONF_WINDOW_BARS = 10_000  # confidence scan window (last K WF bars)
TWO_NIGHT_BUDGET_HOURS = 16.0

# Wave-3 spread-gate-aware tuning (2026-11-01).
#
# Root cause of the wave-1/2 100%-blocked funnel: the ConfidenceEngine
# VolatilityGate multiplier fallback divides a PRICE-DOMAIN XAUUSD ATR
# (~2-12 $) by the pip-scale lookback default (1.0), producing ratios of
# 6-12 > max 3.0 — every signal blocked before the spread gate was even
# reached.  Fix class matches the existing low-side domain-mismatch guard:
# give the gate per-symbol PRICE-DOMAIN ATR bounds instead of the
# meaningless pip-scale ratio.
#
# Additionally: (a) the SpreadGate ceiling is aligned to the ONE-table
# effective spread (max(stats p90, provisional floor)) so gate and cost
# model agree by construction, and (b) an explicit tradability filter
# drops signals whose expected move (ATR) is not a multiple of the spread
# cost — the "min expected move vs spread" requirement — counted as
# blocked so the G5 cost-tradability gate stays honest.
XAUUSD_PIP_SIZE = 0.1  # $ per pip for XAUUSD (digits=2, pip position 2)
SYMBOL_ATR_BOUNDS = {  # price-domain min/max ATR, per symbol.
    # Lower bounds widened to sit below observed ATR minimums on real node
    # data (USDJPY 0.0096, EURUSD 9.1e-5, GBPUSD 1.19e-4; card 929ae3b9)
    # so legitimately observed signals are not gated out (Rin review).
    "XAUUSD": (0.2, 100.0),
    "USDJPY": (0.009, 5.0),
    "EURUSD": (0.00008, 0.05),
    "GBPUSD": (0.0001, 0.05),
}
MIN_MOVE_SPREAD_MULT = 3.0  # ATR must be >= 3x spread to be tradable
SPREAD_SAMPLES_PATH = "data/spreads/xauusd_spread_samples.jsonl"  # legacy default (XAUUSD)
#: Canonical pip size in PRICE units per symbol (reconciled with main
#: d604239a, card 929ae3b9): this map GOVERNS; the spread-stats table's
#: ``pip_size`` field serves only as a cross-check (fail-loud abort on
#: mismatch) so a stale or mis-generated stats file can never silently
#: reintroduce the hardcoded-XAUUSD-pip bug class (Rin review nit 5).
SYMBOL_PIP_SIZE = {
    "XAUUSD": 0.1,
    "EURUSD": 0.0001,
    "GBPUSD": 0.0001,
    "USDJPY": 0.01,
}


def pip_size_for(symbol: str) -> float:
    """PRICE-units-per-pip for a known symbol; fail-loud on unknown."""
    try:
        return SYMBOL_PIP_SIZE[symbol]
    except KeyError:
        print(f"FATAL: unknown symbol {symbol!r}; known: {sorted(SYMBOL_PIP_SIZE)}",
              flush=True)
        raise SystemExit(2) from None


def hourly_spread_profile(path: Path) -> dict[int, float]:
    """Mean sampled spread (pips) per UTC hour from the sampler jsonl.

    Sparse by design (sampler cadence): hours with no samples are absent
    and callers fall back to the ONE-table effective spread.
    """
    if not path.exists():
        return {}
    sums: dict[int, float] = defaultdict(float)
    counts: dict[int, int] = defaultdict(int)
    try:
        with open(path) as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    row = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if row.get("status") != "ok" or row.get("symbol") != SYMBOL:
                    continue
                ts = str(row.get("ts_utc", ""))
                if len(ts) < 13:
                    continue
                hour = int(ts[11:13])
                sums[hour] += float(row.get("spread_pips") or 0.0)
                counts[hour] += 1
    except OSError:
        return {}
    return {h: sums[h] / counts[h] for h in counts if counts[h]}


if TYPE_CHECKING:  # noqa: E402
    from confidence.gates import GateConfig  # noqa: E402


def build_gate_config(tf: str, spread_info: dict) -> "GateConfig":
    """GateConfig for the factory confidence path (wave-3 tuning).

    - SpreadGate ceiling for this symbol:TF = the ONE-table effective
      spread (same value the cost model charges) — gate and cost agree.
    - VolatilityGate gets per-symbol PRICE-domain ATR bounds, replacing
      the pip-scale multiplier fallback that blocked 100% of XAUUSD
      signals (wave-3 root cause).
    """
    from confidence.gates import GateConfig

    lo, hi = SYMBOL_ATR_BOUNDS.get(SYMBOL, (0.0, float("inf")))
    return GateConfig(
        symbol_tf_max_spreads={f"{SYMBOL}:{tf}": float(spread_info["effective_pips"])},
        volatility_min_atr={SYMBOL: lo} if lo > 0 else {},
        volatility_max_atr={SYMBOL: hi} if hi < float("inf") else {},
    )

# Frozen WF geometry (validated engine path, phase-4 cycle conventions)
WF_WINDOWS = 5
TRAIN_RATIO = 0.7
VAL_RATIO = 0.15
OVERLAP_RATIO = 0.2
INITIAL_BALANCE = 10_000.0
COMMISSION_PER_LOT = 3.5
MIN_CONFIDENCE = 0.30
HOLDOUT_FRAC = 0.2


def _utcnow() -> str:
    return datetime.now(timezone.utc).isoformat()


def _md5(path: Path) -> str:
    h = hashlib.md5()  # noqa: S324 — data-integrity digests (not security)
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _atomic_json(path: Path, payload: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(payload, indent=2) + "\n")
    os.replace(tmp, path)


def _git_tip() -> dict:
    git = shutil.which("git") or "/usr/bin/git"
    try:
        tip = subprocess.run(  # noqa: S603 — fixed argv, no user input
            [git, "rev-parse", "HEAD"], cwd=_REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        dirty = subprocess.run(  # noqa: S603 — fixed argv, no user input
            [git, "status", "--porcelain"], cwd=_REPO_ROOT, capture_output=True, text=True, check=True
        ).stdout.strip()
        return {"tip": tip, "dirty": bool(dirty)}
    except Exception:  # noqa: BLE001 — informational only
        return {"tip": "unknown", "dirty": None}


def engine_artifact_suspect(mean_sharpe: float | None,
                            bound: float = ENGINE_ARTIFACT_ABS_SR) -> bool:
    """Hard sanity bound on an aggregated mean Sharpe (card 7be928ff, AC2).

    Wave 1 left 11 rows with |mean_sharpe| >= 100 (max +403.76) for the
    hygiene pass to find post-hoc.  The runner now flags such rows at the
    artifact level, upstream.  The bound is imported from the hygiene tool
    (``forex_bot.factory.hygiene_triage.ENGINE_ARTIFACT_ABS_SR``) so there
    is exactly ONE threshold in the codebase.
    """
    return mean_sharpe is not None and abs(float(mean_sharpe)) >= bound


def engine_artifact_block(mean_sharpe: float | None) -> dict:
    """Artifact-level quarantine record for an engine-artifact suspect row."""
    suspect = engine_artifact_suspect(mean_sharpe)
    return {
        "suspect": suspect,
        "bound_abs_mean_sharpe": ENGINE_ARTIFACT_ABS_SR,
        "observed_mean_sharpe": (round(float(mean_sharpe), 6)
                                 if mean_sharpe is not None else None),
        "action": ("flagged_quarantined_for_hygiene" if suspect else "none"),
        "checked_at_stage": "runner_post_wf",
    }


def atr14(bars: list, i: int) -> float:
    lo = max(0, i - 14)
    trs = []
    for j in range(lo, i):
        pc = bars[j - 1].close if j > 0 else bars[j].open
        trs.append(max(bars[j].high - bars[j].low, abs(bars[j].high - pc), abs(bars[j].low - pc)))
    return sum(trs) / len(trs) if trs else 0.0


def load_bars(csv_path: Path) -> list:
    return CsvDataLoader().load(str(csv_path))


def spread_for_tf(stats: dict, tf: str) -> dict:
    """ONE-table rule: effective spread = max(stats p90, provisional floor).

    Feeds BOTH the SpreadGate context and the cost model.  Until the sampler
    has >=1 week of samples the provisional bootstrap (3.0 pips XAUUSD
    M1-H1, card d6748b27) governs — cost-first (never below the measured
    live profile).
    """
    per_tf = stats["per_timeframe"]
    if tf not in per_tf:
        # FX tables are bootstrapped at M15 only (card 929ae3b9): proxy any
        # missing TF (M1/M5/M30) with the finest available TF's distribution.
        proxy_tf = sorted(per_tf)[0]
        # TODO(cost-re-measure): proxied TFs reuse the M15 spread p90 as a
        # stand-in; once the sampler accumulates per-TF history (>=1 week),
        # re-measure M1/M5/M30 costs natively and retire this proxy so the
        # cost model stops over/under-estimating non-M15 spreads.
        per_tf = {tf: dict(per_tf[proxy_tf], proxied_from=proxy_tf)}
    cell = per_tf[tf]["spread_pips"]
    p90 = float(cell["p90"])
    # Canonical pip map governs (reconciled with main d604239a, Rin nit 5);
    # stats-table pip_size is a cross-check only.
    stats_symbol = stats.get("symbol")
    if stats_symbol and stats_symbol != SYMBOL:
        raise SystemExit(
            f"FATAL: spread stats symbol {stats_symbol!r} != --symbol {SYMBOL!r}"
        )
    pip_size = pip_size_for(SYMBOL)
    if "pip_size" in stats:
        stats_pip = float(stats["pip_size"])
        if abs(stats_pip - pip_size) > max(pip_size, stats_pip) * 1e-6:
            raise SystemExit(
                f"FATAL: spread stats pip_size {stats_pip!r} for {SYMBOL!r} "
                f"contradicts canonical pip_size {pip_size!r} "
                "(SYMBOL_PIP_SIZE governs; fail-loud cross-check)"
            )
    floor = float(PROVISIONAL_SYMBOL_TF_SPREADS.get(f"{SYMBOL}:{tf}", 0.0))
    return {
        "pip_size": pip_size,
        "effective_pips": max(p90, floor),
        "stats_p90_pips": p90,
        "provisional_floor_pips": floor,
        "n_samples": int(per_tf[tf]["n"]),
        "proxied_from": per_tf[tf].get("proxied_from"),
        "applied_to": ["SpreadGate", "cost_model", "confidence_ctx"],
    }


def pilot_selection(candidates: list[dict], n: int) -> list[dict]:
    """First N candidates spanning all TFs (per-TF timing needs coverage)."""
    picked: list[dict] = []
    seen_tf: set[str] = set()
    for tf in ("H1", "M15", "M5"):
        for c in candidates:
            if c["timeframe"] == tf:
                picked.append(c)
                seen_tf.add(tf)
                break
    for c in candidates:
        if len(picked) >= n:
            break
        if c not in picked:
            picked.append(c)
    return picked[:n]


def load_or_freeze_config(args, grid_path: Path, stats_path: Path, data_dir: Path,
                           tfs: list[str], grid_symbol: str | None = None,
                           frozen_path: Path | None = None) -> dict:
    """Freeze the run config BEFORE any candidate runs; validate on resume."""
    # Fail-loud symbol guard (FX symbol-swap fix): a frozen run config whose
    # symbol differs from the grid's symbol means stale/mismatched state —
    # abort before any candidate runs on the wrong instrument's data.
    if frozen_path is not None and grid_symbol and frozen_path.exists():
        try:
            frozen_symbol = json.loads(frozen_path.read_text()).get("symbol")
        except (json.JSONDecodeError, OSError):
            frozen_symbol = None
        if frozen_symbol and frozen_symbol != grid_symbol:
            raise SystemExit(
                f"FATAL: frozen run config symbol {frozen_symbol!r} != grid symbol "
                f"{grid_symbol!r} — refusing to resume a cross-symbol run"
            )
    data_cfg: dict[str, Any] = {}
    for tf in tfs:
        csv_path = data_dir / f"{SYMBOL}_{tf}_full.csv"
        if not csv_path.exists():
            print(f"FATAL: missing data file {csv_path}", flush=True)
            raise SystemExit(2)
        bars = load_bars(csv_path)
        n = len(bars)
        holdout_bars = int(n * args.holdout_frac)
        wf_bars = n - holdout_bars
        data_cfg[tf] = {
            "path": str(csv_path),
            "md5": _md5(csv_path),
            "n_bars": n,
            "first": bars[0].time.isoformat(),
            "last": bars[-1].time.isoformat(),
            "holdout_frac": args.holdout_frac,
            "holdout_bars": holdout_bars,
            "wf_bars": wf_bars,
            "wf_last_bar": bars[wf_bars - 1].time.isoformat(),
            "holdout_first_bar": bars[wf_bars].time.isoformat(),
            "admission_min_bars": ADMISSION_MIN_BARS.get(tf),
            "admission_pass": n >= ADMISSION_MIN_BARS.get(tf, 0),
        }
        del bars
    spread_cfg = {tf: spread_for_tf(json.loads(stats_path.read_text()), tf) for tf in tfs}
    frozen = {
        "schema": "fanout_run_config_v1",
        "card": CARD,
        "sprint": SPRINT,
        "symbol": SYMBOL,
        "created_utc": _utcnow(),
        "frozen_before_runs": True,
        "git": _git_tip(),
        "grid": {"path": str(grid_path), "md5": _md5(grid_path)},
        "data": data_cfg,
        "holdout_rule": f"last {args.holdout_frac:.0%} of bars per TF, excluded from WF and confidence",
        "wf": {
            "n_windows": WF_WINDOWS, "train_ratio": TRAIN_RATIO, "val_ratio": VAL_RATIO,
            "overlap_ratio": OVERLAP_RATIO, "initial_balance": INITIAL_BALANCE,
            "commission_per_lot": COMMISSION_PER_LOT, "min_confidence": MIN_CONFIDENCE,
            "embargo_bars": 0,
        },
        "spread": {
            "rule": "effective = max(stats per-TF p90, PROVISIONAL_SYMBOL_TF_SPREADS floor); "
            "ONE table feeds SpreadGate + cost model",
            "stats_source": {"path": str(stats_path), "md5": _md5(stats_path)},
            "provisional_floor": dict(PROVISIONAL_SYMBOL_TF_SPREADS),
            "effective": spread_cfg,
        },
        "fill_model": {
            "class": "backtest.fill_model.SlippageConfig",
            "config": {k: (v.value if hasattr(v, "value") else v) for k, v in
                       SlippageConfig().__dict__.items()},
            "semantics": "replace (flat slippage_pips zeroed; per-trade model slippage deducted)",
            "source_card": "71e7b0b1-2248-4c70-80bd-85562be56150",
        },
        "admission": dict(ADMISSION_MIN_BARS),
    }
    return frozen


def validate_frozen(existing: dict, fresh: dict) -> None:
    """Fail-loud on any frozen-input drift between resume runs."""
    def _cmp(a, b, path):
        if isinstance(a, dict) and isinstance(b, dict):
            for k in a:
                if k in ("created_utc", "git"):
                    continue
                _cmp(a[k], b.get(k), f"{path}.{k}")
        elif a != b:
            print(f"FATAL: frozen run-config drift at {path}: {a!r} != {b!r}", flush=True)
            raise SystemExit(2)

    for key in ("grid", "data", "wf", "spread", "fill_model", "admission", "holdout_rule"):
        a, b = existing.get(key), fresh.get(key)
        if key == "data" and isinstance(a, dict) and isinstance(b, dict):
            # --only subset invocations cover fewer TFs than the frozen
            # superset — validate the TFs this invocation touches.
            a = {k: v for k, v in a.items() if k in b}
        if key == "spread" and isinstance(a, dict) and isinstance(b, dict):
            a = dict(a)
            a["effective"] = {k: v for k, v in a.get("effective", {}).items()
                              if k in b.get("effective", {})}
        _cmp(a, b, key)
    # NOTE: spread.stats_source.md5 is intentionally NOT frozen-compared —
    # the daily sampler updates the stats file mid-wave; the EFFECTIVE
    # per-TF values derived from it ARE frozen and compared.


def run_candidate(cand: dict, bars: list, spread_info: dict, fill_cfg: SlippageConfig,
                  run_cfg: dict, max_scored: int) -> dict:
    tf = cand["timeframe"]
    family = cand["family"]
    template = FAMILY_GRIDS_ALL[family].template_factory()
    holdout_bars = int(len(bars) * HOLDOUT_FRAC)
    bars_wf = bars[: len(bars) - holdout_bars]

    # Stage 1: cost-aware walk-forward (validated engine + restored fill model)
    t0 = time.perf_counter()
    wf = run_strategy_walk_forward(
        bars=bars_wf,
        strategy_factory=lambda: template.build_strategy(cand["params"], SYMBOL),
        pair=SYMBOL,
        n_windows=WF_WINDOWS,
        train_ratio=TRAIN_RATIO,
        val_ratio=VAL_RATIO,
        overlap_ratio=OVERLAP_RATIO,
        initial_balance=INITIAL_BALANCE,
        spread_pips=spread_info["effective_pips"],
        commission_per_lot=COMMISSION_PER_LOT,
        min_confidence=MIN_CONFIDENCE,
        fill_model_config=fill_cfg,
    )
    wf_wall = time.perf_counter() - t0
    trades = getattr(wf, "_trade_records", []) or []
    trades_costed = sum(1 for r in trades if r.get("fill_model_applied"))
    trades_per_year = _trades_per_year_from_bars(bars_wf, len(trades)) if trades else None
    agg_sharpe = wf.aggregated.mean_sharpe_ratio if wf.aggregated else None

    wf_block = {
        "n_windows": WF_WINDOWS,
        "windows": [
            {"idx": w.window_index, "trades": w.trade_count,
             "win_rate": round(w.win_rate, 6), "profit_factor": round(w.profit_factor, 6),
             "sharpe": round(w.sharpe_ratio, 6), "pnl": round(w.total_pnl, 2),
             "passed_go_nogo": bool(w.passed_go_nogo)}
            for w in wf.per_window
        ],
        "aggregated": (
            {"mean_sharpe": round(wf.aggregated.mean_sharpe_ratio, 6),
             "mean_win_rate": round(wf.aggregated.mean_win_rate, 6),
             "mean_pf": round(wf.aggregated.mean_profit_factor, 6),
             "mean_max_drawdown": round(wf.aggregated.mean_max_drawdown, 6),
             "windows_passed": wf.aggregated.windows_passed,
             "total_windows": wf.aggregated.total_windows}
            if wf.aggregated else {}
        ),
        "go_nogo": bool(wf.go_nogo),
    }

    # Stage 2: confidence scoring (SignalAxis) on a bounded WF-region window
    ce = ConfidenceEngine(build_gate_config(tf, spread_info))
    spread_profile = hourly_spread_profile(_REPO_ROOT / SPREAD_SAMPLES_PATH)
    scan = bars_wf[-CONF_WINDOW_BARS:]
    strategy = template.build_strategy(cand["params"], SYMBOL)
    spread_val = spread_info["effective_pips"]
    signals: list[dict[str, Any]] = []
    scan_tf_minutes = infer_tf_minutes(scan)
    feature_sums: dict[str, float] = {k: 0.0 for k in FEATURE_KEYS}
    n_with_features = 0
    for i, bar in enumerate(scan):
        if len(signals) >= max_scored:
            break
        session = determine_session(bar.time)
        try:
            sig = strategy.evaluate(
                MarketState(bars=scan[: i + 1], current_session=session)
            )
        except Exception:  # noqa: BLE001, S112 — a malformed signal row is data, not a crash; skip silently
            continue
        if sig is None:
            continue
        raw = getattr(sig, "confidence", None)
        if raw is None:
            continue
        feats = getattr(sig, "features", None) or compute_feature_vector(
            scan[: i + 1], session, tf_minutes=scan_tf_minutes
        )
        for k in FEATURE_KEYS:
            v = feats.get(k)
            if v is not None:
                feature_sums[k] += float(v)
        n_with_features += 1
        # Session spread filtering: use the hour's sampled spread when the
        # sampler has data (cost-first: never below the ONE-table effective),
        # so hours with measurably wide spreads are scored against reality.
        hour_spread = spread_profile.get(bar.time.hour)
        ctx_spread = max(spread_val, hour_spread) if hour_spread else spread_val
        atr_val = float(atr14(scan, i))
        # Min-expected-move tradability: drop signals whose ATR is not a
        # multiple of the spread cost — counted as blocked so G5 stays honest.
        if atr_val < MIN_MOVE_SPREAD_MULT * ctx_spread * spread_info["pip_size"]:
            signals.append({
                "i": i, "ts": bar.time.isoformat(),
                "direction": str(getattr(sig, "direction", "long")),
                "raw": float(raw), "spread": float(ctx_spread),
                "atr": atr_val, "hour_utc": bar.time.hour,
                "features": {k: float(v) for k, v in feats.items()},
                "move_filtered": True,
            })
            continue
        signals.append({
            "i": i, "ts": bar.time.isoformat(),
            "direction": str(getattr(sig, "direction", "long")),
            "raw": float(raw), "spread": float(ctx_spread),
            "atr": atr_val, "hour_utc": bar.time.hour,
            "features": {k: float(v) for k, v in feats.items()},
        })

    dist: dict[str, int] = defaultdict(int)
    blocked = 0
    move_filtered = sum(1 for s in signals if s.get("move_filtered"))
    scored_first10: list[dict[str, Any]] = []
    for s in signals:
        if s.get("move_filtered"):
            blocked += 1
            dist["move_filtered"] += 1
            continue
        r = ce.score(s["raw"], symbol=SYMBOL, direction=s["direction"], spread=s["spread"],
                     atr=s["atr"], hour_utc=s["hour_utc"], timeframe=tf)
        bucket = (
            "blocked" if r.blocked
            else ("high" if r.final_score >= 0.7 else ("mid" if r.final_score >= 0.5 else "low"))
        )
        dist[bucket] += 1
        if r.blocked:
            blocked += 1
        if len(scored_first10) < 10:
            scored_first10.append({"ts": s["ts"], "raw": round(s["raw"], 4),
                                   "final": round(r.final_score, 4), "blocked": r.blocked,
                                   "gates_failed": r.gates_failed, "bucket": bucket,
                                   "features": s["features"]})
    total_wall = time.perf_counter() - t0

    # Confidence-feature plumbing (card 741308db AC2): every scored signal
    # carries the six numeric features (strategy-emitted FeatureSignal, or
    # a runner-side fallback computation for v1-family strategies) so the
    # ConfidenceEngine path AND a future ML learner can consume them.
    feature_means = {
        k: (round(feature_sums[k] / n_with_features, 6) if n_with_features else None)
        for k in FEATURE_KEYS
    }
    confidence_features = {
        "producer": "strategy FeatureSignal (v2 families) or runner-side compute_feature_vector fallback",
        "definition": list(FEATURE_KEYS),
        "n_signals_scored": len(signals),
        "n_signals_with_features": n_with_features,
        "means": feature_means,
        "learner_note": "feature plumbing only — no learner wiring in this card",
    }

    return {
        "schema": "fanout_candidate_v1",
        "card": CARD,
        "sprint": SPRINT,
        "candidate_id": cand["candidate_id"],
        "family": family,
        "family_slug": cand.get("family_slug", ""),
        "timeframe": tf,
        "params": cand["params"],
        "geometry": cand.get("geometry", {}),
        "anchor_strategy": cand.get("anchor_strategy", ""),
        "trades_per_year": trades_per_year,
        "status": "completed",
        "engine_artifact": engine_artifact_block(agg_sharpe),
        "data": {
            "n_bars_total": len(bars), "holdout_bars": holdout_bars,
            "wf_bars": len(bars_wf),
            "wf_first": bars_wf[0].time.isoformat(), "wf_last": bars_wf[-1].time.isoformat(),
            "holdout_first": bars[len(bars) - holdout_bars].time.isoformat(),
            "holdout_last": bars[-1].time.isoformat(),
        },
        "spread": spread_info,
        "walk_forward": wf_block,
        "confidence_scores": {
            "producer": "confidence.engine.ConfidenceEngine (SignalAxis)",
            "scan_window_bars": len(scan), "max_scored": max_scored,
            "n_signals_scored": len(signals), "distribution": dict(dist),
            "blocked_count": blocked, "first10": scored_first10,
            "wave3_tuning": {
                "gate_config": "per-symbol price-domain ATR bounds + spread ceiling = ONE-table effective",
                "min_move_spread_mult": MIN_MOVE_SPREAD_MULT,
                "hourly_spread_profile_hours": sorted(spread_profile),
                "move_filtered_count": move_filtered,
            },
        },
        "confidence_features": confidence_features,
        "cost_model": {
            "applied": True,
            "trades_wf": len(trades),
            "trades_costed": trades_costed,
            "walk_forward_wall_seconds": round(wf_wall, 3),
            "semantics": run_cfg["fill_model"]["semantics"],
            "source_card": CARD,
        },
        "timing": {"wall_seconds": round(total_wall, 3), "completed_utc": _utcnow()},
        "git_tip": run_cfg["git"]["tip"],
        "run_config_md5": run_cfg["_md5"],
    }


def _trial_row_from_artifact(art: dict) -> dict:
    """Per-trial false-discovery row (council R2, card 3d75cfd8).

    Every grid trial that RUNS gets one row — including rejects and errors —
    so downstream hygiene derives ``n_trials`` from the trial log (never
    hand-declared) and can build CSCV/PBO matrices from the recorded
    per-window series.
    """
    wf = art.get("walk_forward", {})
    agg = wf.get("aggregated", {})
    windows = wf.get("windows")
    n_trades = sum(int(w.get("trades") or 0) for w in windows) if windows else None
    return {
        "schema": "fanout_trial_row_v1",
        "recorded_utc": _utcnow(),
        "sprint": art.get("sprint", SPRINT),
        "candidate_id": art.get("candidate_id"),
        "family": art.get("family"),
        "timeframe": art.get("timeframe"),
        "cell": f"{art.get('family')}:{art.get('timeframe')}",
        "params": art.get("params", {}),
        "status": art.get("status"),
        "go_nogo": wf.get("go_nogo"),
        "aggregated": agg,
        "windows": windows,
        "n_trades": n_trades,
        "n_signals": (art.get("confidence_scores") or {}).get("n_signals_scored"),
        "trades_per_year": art.get("trades_per_year"),
        "features": (
            {"n_signals": cf.get("n_signals_with_features"), "means": cf.get("means")}
            if (cf := art.get("confidence_features")) else None
        ),
        "engine_artifact": art.get("engine_artifact")
        or engine_artifact_block(agg.get("mean_sharpe")),
        "git_tip": art.get("git_tip"),
        "run_config_md5": art.get("run_config_md5"),
    }


def _append_trial_row(trials_path: Path, art: dict) -> None:
    """Append one trial row (jsonl) — once per candidate that runs."""
    row = _trial_row_from_artifact(art)
    if not row.get("candidate_id"):
        return
    with trials_path.open("a") as fh:
        fh.write(json.dumps(row) + "\n")


def resolve_spread_stats_path(explicit: str | None, symbol: str) -> str:
    """Per-symbol spread-stats default (ONE-table rule, Rin nit 6 coverage).

    Explicit ``--spread-stats`` wins for legacy callers; otherwise prefer
    ``data/spreads/<symbol>_spread_stats.json`` when present, falling back
    to the legacy XAUUSD table only when no per-symbol file exists yet.
    """
    if explicit is not None:
        return explicit
    per_symbol = _REPO_ROOT / "data" / "spreads" / f"{symbol.lower()}_spread_stats.json"
    return str(per_symbol if per_symbol.exists() else _REPO_ROOT / DEFAULT_STATS)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--grid", default=str(_REPO_ROOT / DEFAULT_GRID))
    ap.add_argument("--data-dir", default=str(_REPO_ROOT / DEFAULT_DATA_DIR))
    # Default None: after parsing, resolve to the per-symbol spread table
    # (data/spreads/<symbol>_spread_stats.json) so the ONE-table rule is
    # per-symbol; explicit --spread-stats still wins for legacy callers.
    ap.add_argument("--spread-stats", default=None)
    ap.add_argument("--out-dir", default=str(_REPO_ROOT / "data" / "bqes2" / SPRINT / "candidates"))
    ap.add_argument("--summary", default=None, help="summary path (default out_dir/../run_summary.json)")
    ap.add_argument("--holdout-frac", type=float, default=HOLDOUT_FRAC)
    ap.add_argument("--max-scored", type=int, default=5000)
    ap.add_argument("--pilot", type=int, default=0, help="run first N candidates spanning all TFs")
    ap.add_argument("--only", default="", help="comma-separated candidate ids")
    ap.add_argument("--symbol", default="XAUUSD",
                    help="instrument symbol (default XAUUSD for legacy callers); "
                         "threads into csv resolution, spread filtering, and scoring")
    args = ap.parse_args(argv)
    global SYMBOL
    SYMBOL = args.symbol
    if args.spread_stats is None:
        args.spread_stats = resolve_spread_stats_path(None, SYMBOL)

    grid_path = Path(args.grid)
    stats_path = Path(args.spread_stats)
    data_dir = Path(args.data_dir)
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    summary_path = Path(args.summary) if args.summary else out_dir.parent / "run_summary.json"
    trials_path = out_dir.parent / "trials.jsonl"  # per-trial false-discovery log (card 3d75cfd8)

    catalog = json.loads(grid_path.read_text())
    candidates = catalog["candidates"]
    if len(candidates) != catalog["grid_math"]["candidate_count"]:
        print("FATAL: grid candidate count mismatch", flush=True)
        return 2
    if args.only:
        want = {s.strip() for s in args.only.split(",") if s.strip()}
        candidates = [c for c in candidates if c["candidate_id"] in want]
        missing = want - {c["candidate_id"] for c in candidates}
        if missing:
            print(f"FATAL: unknown candidate ids {sorted(missing)}", flush=True)
            return 2
    if args.pilot:
        candidates = pilot_selection(candidates, args.pilot)

    tfs = sorted({c["timeframe"] for c in candidates})
    run_cfg_path = out_dir / "run_config.json"
    # Freeze across the FULL grid's TFs (not just this invocation's filtered
    # subset) so a resumed unfiltered run never hits a KeyError on a TF the
    # freeze never saw (wave-5 fix: --only smoke then full resume).
    all_tfs = sorted({c["timeframe"] for c in catalog["candidates"]})
    grid_symbol = catalog.get("symbol")
    if grid_symbol and grid_symbol != SYMBOL:
        print(f"FATAL: --symbol {SYMBOL} != grid symbol {grid_symbol}", flush=True)
        return 2
    fresh = load_or_freeze_config(args, grid_path, stats_path, data_dir, all_tfs,
                                  grid_symbol=grid_symbol, frozen_path=run_cfg_path)
    if run_cfg_path.exists():
        existing = json.loads(run_cfg_path.read_text())
        validate_frozen(existing, fresh)
        if set(fresh.get("data", {})) - set(existing.get("data", {})):
            # Existing freeze covers fewer TFs than the grid — adopt the
            # fresh superset (identical values on the shared cells).
            run_cfg = fresh
            _atomic_json(run_cfg_path, run_cfg)
            print("run config: upgraded to full-grid TF freeze", flush=True)
        else:
            run_cfg = existing
            print("run config: existing frozen config validated (resume)", flush=True)
    else:
        run_cfg = fresh
        _atomic_json(run_cfg_path, run_cfg)
        print(f"run config: FROZEN before any candidate run -> {run_cfg_path}", flush=True)
    run_cfg["_path"] = str(run_cfg_path)
    run_cfg["_md5"] = _md5(run_cfg_path)

    fill_cfg = SlippageConfig()
    bars_by_tf: dict[str, list] = {}
    for tf in tfs:
        cell = run_cfg["data"][tf]
        if not cell["admission_pass"]:
            print(f"ADMISSION FAIL {SYMBOL} {tf}: {cell['n_bars']} bars < "
                  f"{cell['admission_min_bars']} — candidates on this TF will be SKIPPED (fail-loud)",
                  flush=True)
            continue
        t0 = time.perf_counter()
        bars_by_tf[tf] = load_bars(Path(cell["path"]))
        print(f"loaded {tf}: {len(bars_by_tf[tf])} bars in {time.perf_counter() - t0:.1f}s", flush=True)

    total = len(candidates)
    rows = []
    errors = 0
    for i, cand in enumerate(candidates, 1):
        cid = cand["candidate_id"]
        tf = cand["timeframe"]
        art_path = out_dir / f"{cid}.json"
        if art_path.exists():
            try:
                prev = json.loads(art_path.read_text())
                if prev.get("status") in ("completed", "skipped_admission"):
                    print(f"[{i}/{total}] {cid} SKIP (resume: {prev['status']})", flush=True)
                    rows.append(_row_from_artifact(prev))
                    continue
            except Exception as exc:  # noqa: BLE001 — corrupt artifact → re-run
                print(f"[{i}/{total}] {cid} resume artifact unreadable ({exc}); re-running", flush=True)
        cell = run_cfg["data"][tf]
        if not cell["admission_pass"]:
            art = {
                "schema": "fanout_candidate_v1", "card": CARD, "sprint": SPRINT,
                "candidate_id": cid, "family": cand["family"], "timeframe": tf,
                "status": "skipped_admission",
                "admission": {"n_bars": cell["n_bars"], "min_bars": cell["admission_min_bars"]},
                "skipped_utc": _utcnow(),
            }
            _atomic_json(art_path, art)
            _append_trial_row(trials_path, art)
            print(f"[{i}/{total}] {cid} SKIPPED_ADMISSION ({cell['n_bars']} < {cell['admission_min_bars']})",
                  flush=True)
            rows.append(_row_from_artifact(art))
            continue
        t0 = time.perf_counter()
        try:
            art = run_candidate(cand, bars_by_tf[tf], run_cfg["spread"]["effective"][tf],
                                fill_cfg, run_cfg, args.max_scored)
            _atomic_json(art_path, art)
            _append_trial_row(trials_path, art)
            agg = art["walk_forward"]["aggregated"]
            print(f"[{i}/{total}] {cid} completed wall={art['timing']['wall_seconds']}s "
                  f"go_nogo={art['walk_forward']['go_nogo']} "
                  f"mean_sharpe={agg.get('mean_sharpe')} signals={art['confidence_scores']['n_signals_scored']} "
                  f"costed={art['cost_model']['trades_costed']}/{art['cost_model']['trades_wf']}", flush=True)
            if art["engine_artifact"]["suspect"]:
                print(f"[{i}/{total}] {cid} ENGINE-ARTIFACT SUSPECT "
                      f"|mean_sharpe|={abs(float(agg.get('mean_sharpe'))):.2f} >= "
                      f"{ENGINE_ARTIFACT_ABS_SR} — flagged/quarantined upstream "
                      "(hygiene will exclude)", flush=True)
        except Exception as exc:  # noqa: BLE001 — night-run resilience: record + continue
            errors += 1
            art = {
                "schema": "fanout_candidate_v1", "card": CARD, "sprint": SPRINT,
                "candidate_id": cid, "family": cand["family"], "timeframe": tf,
                "status": "error", "error": f"{type(exc).__name__}: {exc}",
                "wall_seconds": round(time.perf_counter() - t0, 3), "failed_utc": _utcnow(),
            }
            _atomic_json(art_path, art)
            _append_trial_row(trials_path, art)
            print(f"[{i}/{total}] {cid} ERROR: {art['error']}", flush=True)
        rows.append(_row_from_artifact(art))

    _write_summary(summary_path, rows, total, run_cfg, errors, out_dir, bool(args.pilot))
    return 1 if errors else 0


def _row_from_artifact(art: dict) -> dict:
    agg = art.get("walk_forward", {}).get("aggregated", {})
    conf = art.get("confidence_scores", {})
    return {
        "candidate_id": art.get("candidate_id"),
        "timeframe": art.get("timeframe"),
        "family": art.get("family"),
        "status": art.get("status"),
        "trades_per_year": art.get("trades_per_year"),
        "mean_sharpe": agg.get("mean_sharpe"),
        "mean_pf": agg.get("mean_pf"),
        "mean_win_rate": agg.get("mean_win_rate"),
        "windows_passed": agg.get("windows_passed"),
        "total_windows": agg.get("total_windows"),
        "go_nogo": art.get("walk_forward", {}).get("go_nogo"),
        "engine_artifact_suspect": engine_artifact_suspect(agg.get("mean_sharpe")),
        "n_signals": conf.get("n_signals_scored"),
        "blocked": conf.get("blocked_count"),
        "cost_model_applied": art.get("cost_model", {}).get("applied", False),
        "wall_seconds": art.get("timing", {}).get("wall_seconds") or art.get("wall_seconds"),
    }


def _write_summary(summary_path: Path, rows: list, total: int, run_cfg: dict,
                   errors: int, out_dir: Path, pilot: bool) -> None:
    # Rebuild the FULL funnel from all artifacts (not just this invocation's
    # rows) so partial waves still report the complete picture.  ``errors``
    # (this invocation's crash count) only feeds the exit code, not the funnel.
    all_rows = []
    for art_path in sorted(out_dir.glob("*.json")):
        if art_path.name in ("run_config.json",) or art_path.name.endswith(".tmp"):
            continue
        try:
            all_rows.append(_row_from_artifact(json.loads(art_path.read_text())))
        except Exception as exc:  # noqa: BLE001 — unreadable artifact row excluded from summary
            print(f"summary: skipping unreadable artifact {art_path.name}: {exc}", flush=True)
            continue
    completed = [r for r in all_rows if r["status"] == "completed"]
    walls_by_tf: dict[str, list[float]] = defaultdict(list)
    for r in completed:
        if r["wall_seconds"]:
            walls_by_tf[r["timeframe"]].append(float(r["wall_seconds"]))
    per_tf_mean = {tf: (sum(v) / len(v)) for tf, v in walls_by_tf.items()}
    grid_count = len(json.loads((Path(run_cfg["grid"]["path"])).read_text())["candidates"])
    all_walls = [w for v in walls_by_tf.values() for w in v]
    global_mean = (sum(all_walls) / len(all_walls)) if all_walls else 0.0
    remaining_by_tf: dict[str, int] = defaultdict(int)
    done_ids = {r["candidate_id"] for r in all_rows if r["status"] in ("completed", "skipped_admission")}
    for c in json.loads((Path(run_cfg["grid"]["path"])).read_text())["candidates"]:
        if c["candidate_id"] not in done_ids:
            remaining_by_tf[c["timeframe"]] += 1
    projected_seconds = sum(
        remaining_by_tf.get(tf, 0) * per_tf_mean.get(tf, global_mean) for tf in set(remaining_by_tf) | set(per_tf_mean)
    )
    projected_h = projected_seconds / 3600.0
    summary = {
        "schema": "fanout_run_summary_v1",
        "card": CARD,
        "sprint": SPRINT,
        "generated_utc": _utcnow(),
        "mode": "pilot" if pilot else "full",
        "invocation_candidates": total,
        "git_tip": run_cfg["git"]["tip"],
        "run_config": {"path": str(Path(run_cfg.get("_path", "run_config.json"))), "md5": run_cfg.get("_md5")},
        "funnel": {
            "candidates_total_grid": grid_count,
            "artifacts_present": len(all_rows),
            "completed": len(completed),
            "skipped_admission": sum(1 for r in all_rows if r["status"] == "skipped_admission"),
            "errors": sum(1 for r in all_rows if r["status"] == "error"),
            "passed_wf_go_nogo": sum(1 for r in completed if r.get("go_nogo")),
            "cost_model_applied": sum(1 for r in completed if r.get("cost_model_applied")),
            "engine_artifact_suspects": sum(1 for r in all_rows if r.get("engine_artifact_suspect")),
        },
        "pilot_timing": {
            "per_tf_mean_wall_seconds": {tf: round(v, 1) for tf, v in per_tf_mean.items()},
            "remaining_by_tf": dict(remaining_by_tf),
            "projected_remaining_hours": round(projected_h, 2),
            "two_night_budget_hours": TWO_NIGHT_BUDGET_HOURS,
            "within_two_nights": projected_h <= TWO_NIGHT_BUDGET_HOURS,
        },
        "candidates": all_rows,
    }
    _atomic_json(summary_path, summary)
    print(f"SUMMARY -> {summary_path} completed={len(completed)}/{grid_count} "
          f"errors={summary['funnel']['errors']} "
          f"engine_artifact_suspects={summary['funnel']['engine_artifact_suspects']} "
          f"projected_remaining_h={summary['pilot_timing']['projected_remaining_hours']} "
          f"within_two_nights={summary['pilot_timing']['within_two_nights']}", flush=True)


if __name__ == "__main__":
    raise SystemExit(main())
