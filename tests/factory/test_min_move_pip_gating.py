"""Per-symbol pip-size min-move gating (card b718f0b1).

Covers:
  * spread_for_tf carries the stats table's per-symbol ``pip_size``
    (USDJPY 0.01, EURUSD/GBPUSD 0.0001); legacy XAUUSD stats (no field)
    fall back to the XAUUSD pip constant 0.1;
  * a USDJPY M15 signal (ATR ~0.12 price units, spread ~0.79 pips) that
    the old hardcoded XAUUSD conversion blocked 100% of the time now
    passes the min-expected-move filter;
  * XAUUSD gating is unchanged by the fix (same threshold as before).
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location(
    "run_fanout_pip", REPO / "scripts" / "factory" / "run_fanout.py"
)
rf = importlib.util.module_from_spec(_SPEC)
sys.modules.setdefault("run_fanout_pip", rf)
_SPEC.loader.exec_module(rf)


def _stats(symbol: str, pip_size: float | None, p90: float = 0.79) -> dict:
    st = {
        "schema": "1",
        "symbol": symbol,
        "per_timeframe": {"M15": {"spread_pips": {"p90": p90}, "n": 100}},
    }
    if pip_size is not None:
        st["pip_size"] = pip_size
    return st


def test_pip_size_per_symbol_from_stats():
    assert rf.spread_for_tf(_stats("USDJPY", 0.01), "M15")["pip_size"] == 0.01
    assert rf.spread_for_tf(_stats("EURUSD", 0.0001), "M15")["pip_size"] == 0.0001
    assert rf.spread_for_tf(_stats("GBPUSD", 0.0001), "M15")["pip_size"] == 0.0001


def test_legacy_xauusd_stats_fall_back_to_constant():
    assert rf.spread_for_tf(_stats("XAUUSD", None), "M15")["pip_size"] == 0.1


def test_usdjpy_signal_previously_blocked_now_passes():
    atr = 0.12          # typical USDJPY M15 ATR (price domain)
    spread_pips = 0.79  # usdjpy stats M15 p90
    old_threshold = rf.MIN_MOVE_SPREAD_MULT * spread_pips * rf.XAUUSD_PIP_SIZE
    new_threshold = (
        rf.MIN_MOVE_SPREAD_MULT
        * spread_pips
        * rf.spread_for_tf(_stats("USDJPY", 0.01), "M15")["pip_size"]
    )
    assert atr < old_threshold, "precondition: old gate blocked the signal"
    assert atr >= new_threshold, "fixed gate must admit the signal"


def test_xauusd_gating_threshold_unchanged():
    atr = 1.5
    spread_pips = 2.0
    thr = (
        rf.MIN_MOVE_SPREAD_MULT
        * spread_pips
        * rf.spread_for_tf(_stats("XAUUSD", None), "M15")["pip_size"]
    )
    assert thr == rf.MIN_MOVE_SPREAD_MULT * spread_pips * rf.XAUUSD_PIP_SIZE
    assert atr >= thr


def test_fx_symbols_have_atr_bounds():
    for sym in ("USDJPY", "EURUSD", "GBPUSD"):
        lo, hi = rf.SYMBOL_ATR_BOUNDS[sym]
        assert 0 < lo < hi
