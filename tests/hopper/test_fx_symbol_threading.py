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


def test_pip_size_governed_by_canonical_map(tmp_path, monkeypatch):
    """Canonical SYMBOL_PIP_SIZE governs; missing stats field is tolerated
    (cross-check only per reconciliation with main d604239a, Rin nit 5)."""
    monkeypatch.setattr(rf, "SYMBOL", "EURUSD")
    out = rf.spread_for_tf({"symbol": "EURUSD",
                            "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}},
                           "M15")
    assert out["pip_size"] == rf.SYMBOL_PIP_SIZE["EURUSD"] == 0.0001
    # USDJPY must use 0.01, never the legacy XAUUSD 0.1
    monkeypatch.setattr(rf, "SYMBOL", "USDJPY")
    out = rf.spread_for_tf({"symbol": "USDJPY",
                            "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}},
                           "M15")
    assert out["pip_size"] == 0.01


def test_spread_stats_pip_size_mismatch_fails_loud(tmp_path, monkeypatch):
    """Stats-table pip_size contradicting the canonical map must abort."""
    monkeypatch.setattr(rf, "SYMBOL", "EURUSD")
    stats = {"symbol": "EURUSD", "pip_size": 0.1,  # stale XAUUSD value
             "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}}
    import pytest
    with pytest.raises(SystemExit, match="contradicts canonical pip_size"):
        rf.spread_for_tf(stats, "M15")


def test_spread_stats_symbol_mismatch_fails_loud(tmp_path, monkeypatch):
    """Stats table for another symbol must abort the run."""
    monkeypatch.setattr(rf, "SYMBOL", "EURUSD")
    stats = {"symbol": "GBPUSD", "pip_size": 0.0001,
             "per_timeframe": {"M15": {"spread_pips": {"p90": 1.0}, "n": 10}}}
    import pytest
    with pytest.raises(SystemExit, match="symbol"):
        rf.spread_for_tf(stats, "M15")


# --------------------------------------------------- spread-stats resolution
def test_per_symbol_spread_stats_default_resolution(tmp_path, monkeypatch):
    """Default --spread-stats resolves per-symbol table, legacy fallback,
    and explicit path precedence."""
    monkeypatch.setattr(rf, "_REPO_ROOT", tmp_path)
    spreads = tmp_path / "data" / "spreads"
    spreads.mkdir(parents=True)
    # 1) no per-symbol file -> legacy default
    assert rf.resolve_spread_stats_path(None, "EURUSD").endswith(
        str(rf.DEFAULT_STATS))
    # 2) per-symbol file exists -> per-symbol wins
    per = spreads / "eurusd_spread_stats.json"
    per.write_text("{}", encoding="utf-8")
    assert rf.resolve_spread_stats_path(None, "EURUSD") == str(per)
    # 3) explicit --spread-stats always wins
    assert rf.resolve_spread_stats_path("/tmp/legacy.json", "EURUSD") == "/tmp/legacy.json"


# --------------------------------------------------------- M15 TF proxy path
def test_tf_proxy_marks_proxied_from_and_propagates_pip_size(tmp_path, monkeypatch):
    """Missing TF proxies from finest available TF with proxied_from marker;
    canonical pip_size propagates into the proxied cell."""
    monkeypatch.setattr(rf, "SYMBOL", "GBPUSD")
    stats = {"symbol": "GBPUSD", "pip_size": 0.0001,
             "per_timeframe": {"M15": {"spread_pips": {"p90": 1.5}, "n": 25}}}
    out = rf.spread_for_tf(stats, "M5")
    assert out["proxied_from"] == "M15"
    assert out["pip_size"] == 0.0001
    assert out["effective_pips"] == 1.5  # p90 carried over by the proxy
    # M15 itself is not proxied (marker None, not a TF name)
    direct = rf.spread_for_tf(stats, "M15")
    assert direct.get("proxied_from") is None


def test_unknown_symbol_fails_loud(monkeypatch):
    """Unknown symbol via pip_size_for aborts with SystemExit(2)."""
    import pytest
    with pytest.raises(SystemExit):
        rf.pip_size_for("US30")
