#!/usr/bin/env python3
"""W6 gold-set provider-qualification runner (diet-design §8 hard pre-gate).

Runs the 100-doc gold-set gate (A-protected stratum) against a curated corpus
via the loopback contract path and emits a sealed receipt JSON.

Usage:
  python3 infra/hindsight/bin/qualify_gold_set.py \
      --corpus-root ~/staging/estate-migration/memory-curated \
      [--manifest curation-manifest-v1.2.json] [--out receipt.json]

Exit codes: 0 PASS · 1 FAIL · 2 fatal/usage error.
Real-state application remains ORCHESTRATOR-owned (card d244e8fa).
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
from adapter.gold_set import (  # noqa: E402
    GOLD_N_DOCS,
    GOLD_SEED,
    QualificationFatal,
    run_qualification,
)

MANIFEST_FILENAME = "curation-manifest-v1.2.json"


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="W6 gold-set qualification gate")
    ap.add_argument("--corpus-root", default=os.environ.get("AVA_W6_CORPUS_ROOT"))
    ap.add_argument("--manifest", default=None, help="manifest path (default: <corpus-root>/" + MANIFEST_FILENAME + ")")
    ap.add_argument("--n", type=int, default=GOLD_N_DOCS, help="gold-set size (default 100)")
    ap.add_argument("--seed", default=None, help="override the pinned gold-set seed")
    ap.add_argument("--out", default=None, help="write sealed receipt JSON here")
    ap.add_argument("--no-embed-probe", action="store_true", help="skip the live Ollama probe")
    args = ap.parse_args(argv)
    if not args.corpus_root:
        print("error: --corpus-root (or AVA_W6_CORPUS_ROOT) is required", file=sys.stderr)
        return 2
    manifest_path = args.manifest or str(Path(args.corpus_root) / MANIFEST_FILENAME)
    try:
        manifest = load_manifest(manifest_path)
        reader = CorpusReader(manifest, args.corpus_root)
        receipt = run_qualification(
            manifest,
            reader,
            n=args.n,
            seed=args.seed or GOLD_SEED,
            embed_probe=not args.no_embed_probe,
        )
    except QualificationFatal as exc:
        print(f"FATAL (extraction error, strict mode): {exc}", file=sys.stderr)
        return 2
    except Exception as exc:  # usage/environment errors
        print(f"error: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 2
    sealed = receipt.to_dict()
    rendered = json.dumps(sealed, indent=1, sort_keys=True)
    print(rendered)
    if args.out:
        out = Path(args.out)
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(rendered + "\n", encoding="utf-8")
        print(f"receipt written: {out}", file=sys.stderr)
    return 0 if sealed["verdict"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
