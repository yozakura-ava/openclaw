"""Receipt-key byte-match check (card 1fa4bfcb, Rin trap 2 — write it, never eyeball).

The vendored hopper runner's ``hopper_wave_receipt_v1`` contract must
byte-match the Ayumi-main receipt writer it was reconciled against
(card 929ae3b9 keying @ d604239a3ad44ffd08bfb844fdb2dce060189372):

  * receipt key names, insertion ORDER, and nesting;
  * ``receipts/<wave_id>.json`` filename keying;
  * ``ftmo_qualified_ids`` byte pass-through (no re-formatting between
    the staging report and the receipt — the silent-mismatch class);
  * symbol resolution order: run-summary symbol authoritative, envelope
    symbol advisory, XAUUSD legacy default;
  * ``validate_entry`` uppercase-alphanumeric symbol guard.

The EXPECTED_* fixtures below were AST-extracted from
``Ayumi-main`` ``src/forex_bot/hopper/runner.py`` at d604239a
(2026-11-03, card 1fa4bfcb reconciliation) — not hand-transcribed. The
SOURCE side of the structural assertions is re-derived live from this
repo's runner.py with the same AST extraction, so fixture/implementation
drift fails loud instead of silently mismatching consumers.

Self-contained: loads the vendored runner by file path (stdlib only), so
it runs in any pytest environment.
"""

from __future__ import annotations

import ast
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
RUNNER_PATH = REPO / "src" / "forex_bot" / "hopper" / "runner.py"

# ---- fixtures: AST-extracted from Ayumi-main d604239a _receipt() ----------
EXPECTED_RECEIPT_KEYS = [
    "schema", "wave_id", "symbol", "entry_symbol", "finished_utc",
    "out_dir", "source", "gates", "staged_config", "mode",
]
EXPECTED_SUMMARY_KEYS = [
    "candidates_completed", "go_nogo_passed", "wave_summary_symbol",
]
EXPECTED_GATES_STATIC_KEYS = [
    "ftmo_qualified", "ftmo_qualified_ids", "optuna", "demo_wiring",
]
EXPECTED_RECEIPT_SCHEMA = "hopper_wave_receipt_v1"
# d604239a receipt writer: _write_json(RECEIPTS / f"{wave_id}.json", receipt)
EXPECTED_FILENAME_TMPL = "{wave_id}.json"
EXPECTED_SYMBOL_ERROR = (
    "symbol must be an uppercase alphanumeric instrument code (e.g. GBPUSD)"
)
QUALIFIED_IDS = ["fx-eurusd-kzb20261103b-100", "fx-eurusd-kzb20261103b-103"]


def _load_runner():
    spec = importlib.util.spec_from_file_location("hopper_runner_bymatch", RUNNER_PATH)
    mod = importlib.util.module_from_spec(spec)
    sys.modules.setdefault("hopper_runner_bymatch", mod)
    spec.loader.exec_module(mod)
    return mod


def _dict_literals(fn: ast.AST) -> list[dict]:
    out = []
    for st in ast.walk(fn):
        if isinstance(st, ast.Dict):
            keys = [k.value if isinstance(k, ast.Constant) else None for k in st.keys]
            out.append({"lineno": st.lineno, "keys": keys})
    return out


def _receipt_source_dicts() -> list[dict]:
    """AST of the vendored _receipt(), same extraction as the fixture run."""
    tree = ast.parse(RUNNER_PATH.read_text(encoding="utf-8"))
    found = None
    for node in tree.body:
        if isinstance(node, ast.ClassDef) and node.name == "HopperRunner":
            for fn in node.body:
                if isinstance(fn, ast.FunctionDef) and fn.name == "_receipt":
                    found = _dict_literals(fn)
    assert found is not None, "_receipt() not found in vendored runner"
    return found


def _make_runner(tmp_path, monkeypatch):
    mod = _load_runner()
    for name in ("PENDING", "ACTIVE", "DONE", "FAILED", "RECEIPTS"):
        monkeypatch.setattr(mod, name, tmp_path / name.lower())
    return mod, mod.HopperRunner(python_bin=sys.executable)


# ------------------------------------------------- structural byte-match
def test_receipt_keys_and_order_byte_match_ayumi_main():
    dicts = _receipt_source_dicts()
    receipt_literal = next(d for d in dicts if "schema" in d["keys"])
    assert receipt_literal["keys"] == EXPECTED_RECEIPT_KEYS, (
        "receipt key names/order diverge from Ayumi-main d604239a contract")
    summary_literal = next(d for d in dicts if "candidates_completed" in d["keys"])
    assert summary_literal["keys"] == EXPECTED_SUMMARY_KEYS, (
        "summary key names/order diverge from Ayumi-main d604239a contract")
    gates_literal = next(d for d in dicts if "ftmo_qualified" in d["keys"])
    # gates = {**summary, <static keys>} — first slot is the **summary spread
    assert gates_literal["keys"] == [None] + EXPECTED_GATES_STATIC_KEYS


def test_receipt_schema_and_filename_keying_byte_match():
    _load_runner()
    src = RUNNER_PATH.read_text(encoding="utf-8")
    assert '"schema": "hopper_wave_receipt_v1"' in src
    assert 'RECEIPTS / f"{wave_id}.json"' in src, (
        "receipt filename keying must stay RECEIPTS/<wave_id>.json")


# ---------------------------------------------------- behavioral contract
def _write_run_summary(out_dir: Path, symbol: str | None) -> None:
    payload = {"funnel": {"completed": 12, "passed_wf_go_nogo": 4}}
    if symbol is not None:
        payload["symbol"] = symbol
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "run_summary.json").write_text(json.dumps(payload), encoding="utf-8")


def test_receipt_emitted_keys_order_and_ids_pass_through(
    tmp_path, monkeypatch):
    mod, r = _make_runner(tmp_path, monkeypatch)
    out_dir = tmp_path / "out"
    _write_run_summary(out_dir, "EURUSD")
    ftmo_report = {"qualified": QUALIFIED_IDS}
    receipt = r._receipt(
        "bymatch-wave",
        {"wave_id": "bymatch-wave", "symbol": "EURUSD", "source": "card-1fa4bfcb"},
        out_dir, ftmo_report, "skipped (0 qualifiers)", "n/a")

    # filename keying: receipts/<wave_id>.json
    path = tmp_path / "receipts" / "bymatch-wave.json"
    assert path.exists()
    on_disk = json.loads(path.read_text(encoding="utf-8"))

    assert list(receipt.keys()) == EXPECTED_RECEIPT_KEYS
    assert list(on_disk.keys()) == EXPECTED_RECEIPT_KEYS, (
        "serialized key order must survive the write")
    assert list(receipt["gates"].keys()) == (
        EXPECTED_SUMMARY_KEYS + EXPECTED_GATES_STATIC_KEYS)
    # byte pass-through of qualified ids — no reformatting en route
    assert json.dumps(receipt["gates"]["ftmo_qualified_ids"]) == json.dumps(QUALIFIED_IDS)
    assert on_disk["gates"]["ftmo_qualified_ids"] == QUALIFIED_IDS
    # symbol resolution: run-summary symbol is authoritative
    assert receipt["symbol"] == "EURUSD"
    assert receipt["entry_symbol"] == "EURUSD"
    assert receipt["gates"]["wave_summary_symbol"] == "EURUSD"
    assert receipt["schema"] == EXPECTED_RECEIPT_SCHEMA
    assert receipt["wave_id"] == "bymatch-wave"


def test_receipt_symbol_falls_back_to_entry_then_default(tmp_path, monkeypatch):
    mod, r = _make_runner(tmp_path, monkeypatch)
    out_dir = tmp_path / "out2"

    # 1) no summary symbol -> envelope symbol advisory-recorded and used
    _write_run_summary(out_dir, None)
    receipt = r._receipt("wave-gbp", {"wave_id": "wave-gbp", "symbol": "GBPUSD"},
                         out_dir, {"qualified": []}, "n/a", "n/a")
    assert receipt["symbol"] == "GBPUSD"
    assert receipt["entry_symbol"] == "GBPUSD"

    # 2) neither summary nor envelope symbol -> legacy XAUUSD default
    receipt = r._receipt("wave-legacy", {"wave_id": "wave-legacy"},
                         out_dir, {"qualified": []}, "n/a", "n/a")
    assert receipt["symbol"] == "XAUUSD"
    assert receipt["entry_symbol"] is None


# ------------------------------------------------- validate_entry guard
@pytest.mark.parametrize("bad", ["eurusd", "XauUsd", "XAU USD", "XAU-USD", 123])
def test_validate_entry_rejects_bad_symbols(bad):
    mod = _load_runner()
    entry = {"wave_id": "w", "grid": {"inline": {}}, "data_dir": "data",
             "symbol": bad}
    tmp = REPO  # grid inline + data_dir path checks come first only if set;
    # use a wave_id that passes and grid inline to reach the symbol check:
    entry = {"wave_id": "w", "grid": {"inline": {}},
             "data_dir": str(tmp), "symbol": bad}
    err = mod.validate_entry(entry)
    if isinstance(bad, str):
        assert err == EXPECTED_SYMBOL_ERROR
    else:
        assert err == EXPECTED_SYMBOL_ERROR  # non-str must also be rejected


def test_validate_entry_accepts_valid_and_absent_symbols(tmp_path):
    mod = _load_runner()
    base = {"wave_id": "w", "grid": {"inline": {}}, "data_dir": str(tmp_path)}
    assert mod.validate_entry({**base, "symbol": "EURUSD"}) is None
    assert mod.validate_entry({**base, "symbol": "XAUUSD"}) is None
    assert mod.validate_entry(base) is None  # symbol stays optional
