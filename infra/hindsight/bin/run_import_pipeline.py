#!/usr/bin/env python3
"""W6 12-step import pipeline runner over the curated corpus (spec §5).

Shadow mode (default) executes steps 1-10 (inventory .. proof) against the
manifest-addressed corpus and writes the hash-chained receipt chain — no
target writes. Ingest mode (--qualification with a PASSED gold-set receipt)
adds steps 11-12 through the W4 loopback ContractStore (the qualified write
path). Real-state application stays ORCHESTRATOR-owned (card d244e8fa).

Usage:
  python3 infra/hindsight/bin/run_import_pipeline.py --corpus-root <dir> [--dry-run]
  python3 infra/hindsight/bin/run_import_pipeline.py --corpus-root <dir> \
      --qualification gold-receipt.json --out-dir receipts/

Exit codes: 0 success (halt counts as handled, see receipts) · 1 gate/halt ·
2 fatal/usage error.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

_PKG_ROOT = Path(__file__).resolve().parent.parent  # infra/hindsight
sys.path.insert(0, str(_PKG_ROOT))

from adapter.corpus import CorpusReader, load_manifest  # noqa: E402
from adapter.import_contract import ContractStore  # noqa: E402
from adapter.pipeline import Pipeline  # noqa: E402
from adapter.tier_contract import ALL_TIERS  # noqa: E402

MANIFEST_FILENAME = "curation-manifest-v1.2.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="W6 12-step import pipeline")
    ap.add_argument("--corpus-root", default=os.environ.get("AVA_W6_CORPUS_ROOT"))
    ap.add_argument("--manifest", default=None)
    ap.add_argument("--out-dir", default=None, help="receipt chain output dir")
    ap.add_argument("--qualification", default=None,
                    help="PASSED gold-set receipt JSON (required for ingest)")
    ap.add_argument("--batch-size", type=int, default=200)
    ap.add_argument("--tiers", default=None, help="comma list (default: all %d)" % len(ALL_TIERS))
    ap.add_argument("--holdout-quarantine", action="store_true",
                    help="D-suspect/D-ghost-window never ingested (default: ingest into quarantine bank)")
    ap.add_argument("--dry-run", action="store_true",
                    help="steps 1-10 only (shadow curation, no target writes)")
    args = ap.parse_args(argv)
    if not args.corpus_root:
        print("error: --corpus-root (or AVA_W6_CORPUS_ROOT) is required", file=sys.stderr)
        return 2
    manifest_path = args.manifest or str(Path(args.corpus_root) / MANIFEST_FILENAME)
    tiers = [t.strip() for t in args.tiers.split(",")] if args.tiers else None
    try:
        manifest = load_manifest(manifest_path)
        reader = CorpusReader(manifest, args.corpus_root)
        pipe = Pipeline(
            manifest,
            reader,
            batch_size=args.batch_size,
            holdout_quarantine=args.holdout_quarantine,
        )
        receipt = None
        if not args.dry_run:
            if not args.qualification:
                print(
                    "error: ingest requires --qualification (PASSED gold-set receipt); "
                    "use --dry-run for shadow-only steps 1-10",
                    file=sys.stderr,
                )
                return 2
            receipt = json.loads(Path(args.qualification).read_text())
            if receipt.get("verdict") != "PASS":
                print("error: qualification receipt is not PASS — ingest refused",
                      file=sys.stderr)
                return 1
        store = ContractStore() if not args.dry_run else None
        state = pipe.run(
            tiers=tiers,
            store=store,
            qualification_receipt=receipt,
            do_ingest=not args.dry_run,
        )
    except Exception as exc:
        print(f"fatal: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    summary = {
        "records": len(state.records),
        "ingested": sum(1 for r in state.records if r.operation_id),
        "halted": state.halted,
        "halt_reason": state.halt_reason,
        "batches": {b: v["state"] for b, v in state.batches.items()},
        "coverage": pipe.coverage_deltas(),
        "third_reviewer_queue": len(state.third_reviewer_queue),
        "consolidation": "off",
        "receipts": len(state.receipts.as_list()),
    }
    if args.out_dir:
        paths = state.receipts.write_dir(args.out_dir)
        Path(args.out_dir, "run-summary.json").write_text(
            json.dumps(summary, indent=1, sort_keys=True) + "\n", encoding="utf-8"
        )
        print(f"receipts written: {len(paths)} files under {args.out_dir}", file=sys.stderr)
    print(json.dumps(summary, indent=1, sort_keys=True))
    return 1 if state.halted else 0


if __name__ == "__main__":
    sys.exit(main())
