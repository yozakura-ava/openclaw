"""FX symbol-swap fix (card bf928df1): envelope symbol threading + fail-loud guard.

Covers:
  * runner claim path forwards the envelope's ``symbol`` to the fanout
    stage argv as ``--symbol <sym>`` (previously hardcoded XAUUSD path);
  * fanout ``--symbol`` threads into CSV resolution and the frozen run
    config (EURUSD_M15_full.csv, not XAUUSD_M15_full.csv);
  * fail-loud: resuming with a frozen run-config symbol that differs from
    the grid's symbol aborts before any candidate runs.
"""

from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from forex_bot.hopper import runner as runner_mod
from forex_bot.hopper.runner import HopperRunner

REPO = Path(__file__).resolve().parents[2]
_SPEC = importlib.util.spec_from_file_location(
    "run_fanout_sym", REPO / "scripts" / "factory" / "run_fanout.py"
)
rf = importlib.util.module_from_spec(_SPEC)
sys.modules.setdefault("run_fanout_sym", rf)
_SPEC.loader.exec_module(rf)


# ------------------------------------------------------------- runner argv
def _make_entry(tmp_path: Path, symbol: str) -> Path:
    grid = {"version": 1, "symbol": symbol, "grid_math": {"candidate_count": 1},
            "candidates": []}
    gpath = tmp_path / "grid_inline_src.json"
    gpath.write_text(json.dumps(grid), encoding="utf-8")
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    entry = {
        "wave_id": "fx-test-wave",
        "symbol": symbol,
        "data_dir": str(data_dir),
        "grid": {"path": str(gpath)},
    }
    p = tmp_path / "fx-test-wave.json"
    p.write_text(json.dumps(entry), encoding="utf-8")
    return p


def test_runner_forwards_envelope_symbol_to_fanout(tmp_path, monkeypatch):
    """The fanout stage argv must carry the claimed envelope's symbol."""
    entry_path = _make_entry(tmp_path, "EURUSD")
    # isolate ALL runner filesystem state under tmp_path
    monkeypatch.setattr(runner_mod, "_REPO_ROOT", tmp_path)
    q = tmp_path / "hopper-queue"
    for name in ("PENDING", "ACTIVE", "DONE", "FAILED", "RECEIPTS",
                 "STATE_FILE", "LOG_FILE"):
        monkeypatch.setattr(runner_mod, name, q / (name.lower() + ".loc"))
    r = HopperRunner(python_bin=sys.executable)
    captured: dict = {}

    def fake_stage(wave_id, cur, stage, cmd):
        captured["stage"] = stage
        captured["cmd"] = list(cmd)
        return "ok"

    monkeypatch.setattr(r, "_stage", fake_stage)
    monkeypatch.setattr(r, "_receipt", lambda *a, **k: {"wave_id": a[0]})
    # stub the downstream stages out by failing after fanout is captured
    class _AfterFanout(Exception):
        pass

    def fake_stage2(wave_id, cur, stage, cmd):
        captured["stage"] = stage
        captured["cmd"] = list(cmd)
        if stage == "fanout":
            raise _AfterFanout()
        return "ok"

    monkeypatch.setattr(r, "_stage", fake_stage2)
    try:
        r.process_wave(entry_path)
    except _AfterFanout:
        pass
    assert captured["stage"] == "fanout"
    argv = captured["cmd"]
    i = argv.index("--symbol")
    assert argv[i + 1] == "EURUSD"


# ------------------------------------------------- fanout symbol threading
def _fake_args(data_dir: Path):
    class A:
        holdout_frac = 0.2
    return A()


def test_load_or_freeze_uses_symbol_csv_paths(tmp_path, monkeypatch):
    """--symbol EURUSD resolves EURUSD_<TF>_full.csv and freezes symbol."""
    from forex_bot.backtest.types import Bar
    from datetime import datetime, timedelta as _td, timezone

    data_dir = tmp_path / "data"
    data_dir.mkdir()
    csv = data_dir / "EURUSD_M15_full.csv"
    bars = [Bar(time=datetime(2026, 1, 1, tzinfo=timezone.utc) + _td(minutes=15 * i),
                open=1.1, high=1.1, low=1.1, close=1.1, volume=1)
            for i in range(40)]
    monkeypatch.setattr(rf, "load_bars", lambda p: bars)
    csv.write_text("x", encoding="utf-8")  # existence + md5 only
    stats = tmp_path / "stats.json"
    stats.write_text(json.dumps(
        {"symbol": "EURUSD", "pip_size": 0.0001,
         "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}}),
        encoding="utf-8")
    grid = tmp_path / "grid.json"
    grid.write_text("{}", encoding="utf-8")

    rf.SYMBOL = "EURUSD"
    cfg = rf.load_or_freeze_config(_fake_args(data_dir), grid, stats, data_dir,
                                   ["M15"], grid_symbol="EURUSD")
    assert cfg["symbol"] == "EURUSD"
    assert cfg["data"]["M15"]["path"] == str(csv)


def test_fail_loud_frozen_symbol_mismatch(tmp_path):
    """Frozen config symbol XAUUSD vs grid symbol GBPUSD must abort."""
    data_dir = tmp_path / "data"
    data_dir.mkdir()
    stats = tmp_path / "stats.json"
    stats.write_text("{}", encoding="utf-8")
    grid = tmp_path / "grid.json"
    grid.write_text("{}", encoding="utf-8")
    frozen = tmp_path / "run_config.json"
    frozen.write_text(json.dumps({"symbol": "XAUUSD"}), encoding="utf-8")

    rf.SYMBOL = "GBPUSD"
    try:
        rf.load_or_freeze_config(_fake_args(data_dir), grid, stats, data_dir,
                                 ["M15"], grid_symbol="GBPUSD", frozen_path=frozen)
    except SystemExit as exc:
        assert "XAUUSD" in str(exc) and "GBPUSD" in str(exc)
    else:
        raise AssertionError("expected fail-loud SystemExit on symbol mismatch")


def test_default_symbol_is_xauusd_for_legacy_callers():
    assert rf.SYMBOL == "GBPUSD" or rf.SYMBOL  # reassigned by earlier tests
    import subprocess
    code = (
        "import importlib.util,sys;spec=importlib.util.spec_from_file_location("
        "'rf','scripts/factory/run_fanout.py');m=importlib.util.module_from_spec(spec);"
        "spec.loader.exec_module(m);print(m.SYMBOL)")
    out = subprocess.run([sys.executable, "-c", code], capture_output=True, text=True,
                         cwd=str(REPO))
    assert out.stdout.strip() == "XAUUSD"


def test_spread_stats_missing_pip_size_fails_loud(tmp_path):
    """Non-XAUUSD stats lacking pip_size must abort, not fall back to 0.1."""
    stats = tmp_path / "stats.json"
    stats.write_text(json.dumps(
        {"symbol": "EURUSD",
         "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}}),
        encoding="utf-8")
    rf.SYMBOL = "EURUSD"
    import pytest
    with pytest.raises(SystemExit, match="pip_size"):
        rf.spread_for_tf(json.loads(stats.read_text()), "M15")


def test_spread_stats_symbol_mismatch_fails_loud(tmp_path):
    """Stats table for another symbol must abort the run."""
    stats = tmp_path / "stats.json"
    stats.write_text(json.dumps(
        {"symbol": "GBPUSD", "pip_size": 0.0001,
         "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}}),
        encoding="utf-8")
    rf.SYMBOL = "EURUSD"
    import pytest
    with pytest.raises(SystemExit, match="symbol"):
        rf.spread_for_tf(json.loads(stats.read_text()), "M15")
