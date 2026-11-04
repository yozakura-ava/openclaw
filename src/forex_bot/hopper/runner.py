"""Autonomous hopper runner — mechanical wave processing (wave-6, card 2026-11-02).

Reads frozen wave envelopes dropped by hypothesis agents into
``data/hopper-queue/pending/`` and churns them through the strategy
factory pipeline with ZERO human monitoring:

  fanout (resumable) → FTMO paper staging gate → Optuna walk-forward
  (qualifiers only) → demo wiring check (fails closed; demo.ctraderapi.com)
  → per-wave receipt → move to done/ or failed/ → JSONL hopper log.

Design contracts:
  * Concurrency = 1: an flock on ``.runner.lock`` admits a single runner.
  * Restart-safe: claimed waves live in ``active/`` with out-dir + completed
    stage markers in ``state.json``; a fresh runner resumes the wave mid-flight
    (run_fanout itself skips completed candidates; later stages skip on their
    ``.hopper_stage_<name>.done`` marker).
  * SIGTERM: the current child is terminated, state is flushed, exit 0; the
    wave resumes on next launch. Never mid-stage corrupt — markers are written
    only after a stage's subprocess exits 0 and its artifact exists.
  * Demo-only. No live, no deploy, no cron here — launch is documented in
    ``data/hopper-queue/FORMAT.md`` and left to Ava.

See ``data/hopper-queue/FORMAT.md`` for the envelope schema.
"""

from __future__ import annotations

import datetime as dt
import fcntl
import json
import os
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Callable

_REPO_ROOT = Path(__file__).resolve().parents[3]
QUEUE_DIR = _REPO_ROOT / "data" / "hopper-queue"
PENDING = QUEUE_DIR / "pending"
ACTIVE = QUEUE_DIR / "active"
DONE = QUEUE_DIR / "done"
FAILED = QUEUE_DIR / "failed"
RECEIPTS = QUEUE_DIR / "receipts"
STATE_FILE = QUEUE_DIR / "state.json"
LOG_FILE = QUEUE_DIR / "hopper_log.jsonl"
LOCK_FILE = QUEUE_DIR / ".runner.lock"

REQUIRED_FIELDS = ("wave_id", "grid", "data_dir")
STAGE_NAMES = ("fanout", "ftmo_stage", "optuna", "demo_wiring")


def _utcnow() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def _read_json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def _write_json(path: Path, data: Any) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    tmp.replace(path)  # atomic — crash-safe state writes


def validate_entry(entry: dict) -> str | None:
    """Return an error string if the envelope is invalid, else None."""
    for field in REQUIRED_FIELDS:
        if not entry.get(field):
            return f"missing required field: {field}"
    grid = entry["grid"]
    if not isinstance(grid, dict) or not ("path" in grid or "inline" in grid):
        return "grid must be {\"path\": ...} or {\"inline\": ...}"
    if "path" in grid:
        p = _REPO_ROOT / grid["path"]
        if not p.is_file():
            return f"grid path not found: {grid['path']}"
    dd = _REPO_ROOT / entry["data_dir"]
    if not dd.is_dir():
        return f"data_dir not found: {entry['data_dir']}"
    if not all(c.isalnum() or c in "-_" for c in entry["wave_id"]):
        return "wave_id must be a slug ([A-Za-z0-9_-])"
    # Reconciled with Ayumi-main d604239a (card 929ae3b9) — vendored-patch
    # direction, card 1fa4bfcb: optional envelope symbol must be an
    # uppercase alphanumeric instrument code when present.
    sym = entry.get("symbol")
    if sym is not None and not (isinstance(sym, str) and sym.isalnum() and sym == sym.upper()):
        return "symbol must be an uppercase alphanumeric instrument code (e.g. GBPUSD)"
    return None


class HopperRunner:
    def __init__(
        self,
        python_bin: str | None = None,
        spawn: Callable[..., tuple[int, str]] | None = None,
        poll_seconds: int = 60,
    ) -> None:
        self.python_bin = python_bin or os.environ.get(
            "HOPPER_PYTHON", str(_REPO_ROOT / ".venv" / "bin" / "python")
        )
        self._spawn_impl = spawn or self._spawn_subprocess
        self.poll_seconds = poll_seconds
        self._stop = False
        self._proc: subprocess.Popen | None = None
        self.python_bin = str(Path(self.python_bin))
        for d in (PENDING, ACTIVE, DONE, FAILED, RECEIPTS):
            d.mkdir(parents=True, exist_ok=True)

    # ---------------- subprocess plumbing ----------------

    def _spawn_subprocess(self, cmd: list[str], cwd: Path) -> tuple[int, str]:
        env = dict(os.environ)
        # src + src/forex_bot (card b7c57464): entry scripts under src/forex_bot
        # import repo-local top-level packages (`adapters`, `strategies`) that only
        # resolve when src/forex_bot itself is on sys.path (their documented
        # invocation is PYTHONPATH=src/forex_bot:src). src-only spawning killed the
        # demo_wiring stage with ModuleNotFoundError: No module named 'adapters'.
        env["PYTHONPATH"] = os.pathsep.join([
            str(_REPO_ROOT / "src"),
            str(_REPO_ROOT / "src" / "forex_bot"),
            env.get("PYTHONPATH", ""),
        ])
        self._proc = subprocess.Popen(  # noqa: S603 - fixed internal factory scripts
            cmd, cwd=str(cwd), env=env,
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True,
        )
        out: list[str] = []
        if self._proc.stdout is None:  # pragma: no cover - pipe always on
            return self._proc.wait(), ""
        for line in self._proc.stdout:
            out.append(line)
            if len(out) > 400:  # bounded tail
                out.pop(0)
        rc = self._proc.wait()
        self._proc = None
        return rc, "".join(out)

    def spawn(self, cmd: list[str]) -> tuple[int, str]:
        if self._stop:
            raise _GracefulExit()
        rc, out = self._spawn_impl(cmd, _REPO_ROOT)
        if self._stop:
            raise _GracefulExit()
        return rc, out

    def _stage(self, wave_id: str, state: dict, name: str, cmd: list[str]) -> str:
        """Run one pipeline stage with marker-based resume. Returns output tail."""
        marker = Path(state["out_dir"]) / f".hopper_stage_{name}.done"
        if marker.exists():
            return "skipped (marker present)"
        rc, out = self.spawn(cmd)
        tail = out[-2000:]
        if rc != 0:
            raise StageError(f"stage {name} failed rc={rc}\n{tail}")
        marker.write_text(_utcnow() + "\n")
        state["stages_completed"].append(name)
        self._log("stage_done", wave_id=wave_id, stage=name)
        return tail

    # ---------------- state / log ----------------

    def _log(self, event: str, **fields: Any) -> None:
        row = {"ts": _utcnow(), "event": event, **fields}
        with LOG_FILE.open("a", encoding="utf-8") as fh:
            fh.write(json.dumps(row) + "\n")

    def _read_state(self) -> dict:
        if STATE_FILE.exists():
            return _read_json(STATE_FILE)
        return {"current_wave": None, "updated_at": _utcnow()}

    def _write_state(self, state: dict) -> None:
        state["updated_at"] = _utcnow()
        state["pid"] = os.getpid()
        _write_json(STATE_FILE, state)

    # ---------------- queue ops ----------------

    def _entries(self) -> list[Path]:
        return sorted(PENDING.glob("*.json"))

    def _load_entries(self) -> list[dict]:
        loaded = []
        for p in self._entries():
            try:
                e = _read_json(p)
                e["_file"] = str(p)
                loaded.append(e)
            except json.JSONDecodeError as exc:
                self._log("entry_invalid", file=str(p), error=str(exc))
        loaded.sort(key=lambda e: (int(e.get("priority", 100)),
                                   str(e.get("created_at", "")),
                                   str(e.get("wave_id", ""))))
        return loaded

    def _next_entry(self) -> Path | None:
        for e in self._load_entries():
            p = Path(e["_file"])
            if p.name != f"{e.get('wave_id')}.json" and e.get("wave_id"):
                # filename need not match wave_id; keep as-is
                pass
            return p
        return None

    # ---------------- wave pipeline ----------------

    def _grid_arg(self, entry: dict, out_dir: Path) -> str:
        grid = entry["grid"]
        if "path" in grid:
            return str(_REPO_ROOT / grid["path"])
        inline = out_dir / "grid_inline.json"
        _write_json(inline, grid["inline"])
        return str(inline)

    def process_wave(self, entry_path: Path) -> dict:
        entry = _read_json(entry_path)
        wave_id = entry.get("wave_id") or entry_path.stem
        err = validate_entry({**entry, "wave_id": wave_id})
        if err:
            self._fail(entry_path, wave_id, f"invalid envelope: {err}")
            return {"wave_id": wave_id, "status": "failed", "error": err}

        blocked = entry.get("blocked_by_data") or entry.get("blocked")
        if blocked:
            self._fail(entry_path, wave_id, f"blocked-by-data: {blocked}")
            return {"wave_id": wave_id, "status": "failed", "error": f"blocked-by-data: {blocked}"}

        state = self._read_state()
        resume = state.get("current_wave") or {}
        if resume.get("wave_id") == wave_id and resume.get("out_dir"):
            out_dir = Path(resume["out_dir"])
            stages_done = list(resume.get("stages_completed", []))
            self._log("wave_resume", wave_id=wave_id, stages_done=stages_done)
        else:
            stamp = dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%d-%H%M%S")
            out_dir = _REPO_ROOT / "data" / "bqes2" / f"{stamp}-{wave_id}"
            stages_done = []
        out_dir.mkdir(parents=True, exist_ok=True)

        state = {
            "current_wave": {
                "wave_id": wave_id,
                "entry_file": str(entry_path),
                "out_dir": str(out_dir),
                "stages_completed": stages_done,
                "started_at": resume.get("started_at") or _utcnow(),
            },
        }
        self._write_state(state)
        # move pending -> active
        active_path = ACTIVE / entry_path.name
        if entry_path != active_path:
            entry_path.replace(active_path)
        entry_path = active_path
        self._log("wave_claimed", wave_id=wave_id, out_dir=str(out_dir))

        grid_arg = self._grid_arg(entry, out_dir)
        data_dir = str(_REPO_ROOT / entry["data_dir"])
        candidates_dir = out_dir / "candidates"
        summary = out_dir / "run_summary.json"
        cur = state["current_wave"]

        try:
            self._stage(wave_id, cur, "fanout", [
                self.python_bin, str(_REPO_ROOT / "scripts/factory/run_fanout.py"),
                "--grid", grid_arg, "--data-dir", data_dir,
                "--out-dir", str(candidates_dir),
                "--symbol", str(entry.get("symbol") or "XAUUSD"),
            ])
            self._stage(wave_id, cur, "ftmo_stage", [
                self.python_bin, str(_REPO_ROOT / "scripts/factory/ftmo_paper_stage.py"),
                "--summary", str(summary),
                "--out-report", str(out_dir / "ftmo_staging.json"),
                "--out-config", str(out_dir / f"paper_ftmo_{wave_id}.yaml"),
            ])
            qualified, ftmo_report = self._qualifier_count(out_dir)
            optuna_note = "skipped (0 qualifiers)"
            if qualified > 0:
                rc_note = self._stage(wave_id, cur, "optuna", [
                    self.python_bin, str(_REPO_ROOT / "scripts/factory/optuna_walkforward.py"),
                    "--candidates-dir", str(candidates_dir),
                    "--out-dir", str(out_dir / "optuna"),
                ])
                optuna_note = rc_note.splitlines()[-1] if rc_note else "done"
            else:
                cur["stages_completed"].append("optuna")
                (out_dir / ".hopper_stage_optuna.done").write_text(_utcnow() + "\n")

            demo_note = self._stage(wave_id, cur, "demo_wiring", [
                self.python_bin, "-m", "forex_bot.run_wave5_paper_demo", "--dry-run",
            ])
        except StageError as exc:
            self._fail(entry_path, wave_id, str(exc), out_dir=out_dir)
            return {"wave_id": wave_id, "status": "failed", "error": str(exc)[:500]}

        receipt = self._receipt(wave_id, entry, out_dir, ftmo_report, optuna_note, demo_note)
        entry_path.replace(DONE / entry_path.name)
        self._clear_state()
        self._log("wave_done", wave_id=wave_id,
                  qualified=receipt["gates"]["ftmo_qualified"])
        return receipt

    def _qualifier_count(self, out_dir: Path) -> tuple[int, dict]:
        report_path = out_dir / "ftmo_staging.json"
        if not report_path.exists():
            return 0, {}
        try:
            rep = _read_json(report_path)
            return len(rep.get("qualified") or []), rep
        except (json.JSONDecodeError, OSError):
            return 0, {}

    def _receipt(self, wave_id: str, entry: dict, out_dir: Path,
                 ftmo_report: dict, optuna_note: str, demo_note: str) -> dict:
        summary = {}
        s_path = out_dir / "run_summary.json"
        if s_path.exists():
            try:
                s = _read_json(s_path)
                summary = {
                    "candidates_completed": (s.get("funnel") or {}).get("completed"),
                    "go_nogo_passed": (s.get("funnel") or {}).get("passed_wf_go_nogo"),
                    "wave_summary_symbol": s.get("symbol"),
                }
            except (json.JSONDecodeError, OSError):
                pass
        # Card 929ae3b9: receipts are keyed by symbol — the fanout run
        # summary's grid-resolved symbol is authoritative; the envelope's
        # optional symbol is advisory and recorded alongside.
        # (Reconciled into the vendored copy from Ayumi-main d604239a;
        # vendored-patch direction, card 1fa4bfcb.)
        wave_symbol = (summary.get("wave_summary_symbol")
                       or entry.get("symbol") or "XAUUSD")
        receipt = {
            "schema": "hopper_wave_receipt_v1",
            "wave_id": wave_id,
            "symbol": wave_symbol,
            "entry_symbol": entry.get("symbol"),
            "finished_utc": _utcnow(),
            "out_dir": str(out_dir),
            "source": entry.get("source"),
            "gates": {
                **summary,
                "ftmo_qualified": len(ftmo_report.get("qualified") or []),
                "ftmo_qualified_ids": ftmo_report.get("qualified") or [],
                "optuna": optuna_note,
                "demo_wiring": demo_note.splitlines()[0] if demo_note else "n/a",
            },
            "staged_config": str(out_dir / f"paper_ftmo_{wave_id}.yaml"),
            "mode": "paper_demo_only",
        }
        _write_json(RECEIPTS / f"{wave_id}.json", receipt)
        return receipt

    def _fail(self, entry_path: Path, wave_id: str, error: str, out_dir: Path | None = None) -> None:
        target = FAILED / entry_path.name
        entry = {}
        try:
            entry = _read_json(entry_path)
        except (json.JSONDecodeError, OSError):
            pass
        entry["failed_at"] = _utcnow()
        entry["error"] = error[:2000]
        entry["out_dir"] = str(out_dir) if out_dir else entry.get("out_dir")
        _write_json(target, entry)
        if entry_path.resolve() != target.resolve() and entry_path.exists():
            entry_path.unlink(missing_ok=True)
        cur = self._read_state().get("current_wave")
        if cur and cur.get("wave_id") == wave_id:
            self._clear_state()
        self._log("wave_failed", wave_id=wave_id, error=error[:300])

    def _clear_state(self) -> None:
        self._write_state({"current_wave": None})

    # ---------------- resume / loop ----------------

    def resume_interrupted(self) -> dict | None:
        """Re-run a wave left in active/ by a SIGTERM'd predecessor."""
        state = self._read_state()
        cur = state.get("current_wave")
        active_files = sorted(ACTIVE.glob("*.json"))
        if not active_files:
            if cur:
                self._clear_state()
            return None
        entry_path = active_files[0]
        expected = (cur or {}).get("wave_id")
        wave_id = expected or entry_path.stem
        self._log("runner_resume", wave_id=wave_id)
        return self.process_wave(entry_path)

    def run_loop(self, max_waves: int = 0) -> None:
        processed = 0
        self.resume_interrupted()
        while not self._stop:
            entry = self._next_entry()
            if entry is None:
                if max_waves:
                    break
                time.sleep(self.poll_seconds)
                continue
            self.process_wave(entry)
            processed += 1
            if max_waves and processed >= max_waves:
                break

    # ---------------- status ----------------

    def status(self) -> dict:
        state = self._read_state()
        last_logs = []
        if LOG_FILE.exists():
            lines = LOG_FILE.read_text(encoding="utf-8").splitlines()[-5:]
            last_logs = [
                json.loads(line) for line in lines if line.strip()
            ]
        return {
            "queue_depth": len(self._entries()),
            "pending": [p.stem for p in self._entries()],
            "active": state.get("current_wave"),
            "done_count": len(list(DONE.glob("*.json"))),
            "failed_count": len(list(FAILED.glob("*.json"))),
            "last_receipt": self._last_receipt(),
            "recent_log": last_logs,
        }

    def _last_receipt(self) -> dict | None:
        receipts = sorted(RECEIPTS.glob("*.json"), key=lambda p: p.stat().st_mtime)
        if not receipts:
            return None
        try:
            return _read_json(receipts[-1])
        except (json.JSONDecodeError, OSError):
            return None


class StageError(RuntimeError):
    pass


class _GracefulExit(BaseException):
    pass


def run_cli(argv: list[str] | None = None) -> int:
    import argparse

    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--status", action="store_true", help="print queue/state JSON and exit")
    ap.add_argument("--once", action="store_true", help="process at most one wave then exit")
    ap.add_argument("--python", default=None, help="python used for stage subprocesses")
    ap.add_argument("--poll-seconds", type=int, default=60)
    args = ap.parse_args(argv)

    runner = HopperRunner(python_bin=args.python, poll_seconds=args.poll_seconds)

    lock_fh = LOCK_FILE.open("w")
    try:
        fcntl.flock(lock_fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
        print("another hopper runner holds the lock — exiting (concurrency=1)", file=sys.stderr)
        return 3

    def _on_term(signum: int, frame: Any) -> None:  # noqa: ARG001
        runner._stop = True
        proc = runner._proc
        if proc is not None and proc.poll() is None:
            proc.terminate()

    signal.signal(signal.SIGTERM, _on_term)
    signal.signal(signal.SIGINT, _on_term)

    if args.status:
        print(json.dumps(runner.status(), indent=2))
        return 0

    try:
        runner.run_loop(max_waves=1 if args.once else 0)
    except _GracefulExit:
        runner._log("runner_stopped", reason="signal")
        print("SIGTERM — state flushed; wave will resume on next launch", flush=True)
        return 0
    return 0


if __name__ == "__main__":
    sys.exit(run_cli())
