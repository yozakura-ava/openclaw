
---

# W6 — 12-step import pipeline over the curated corpus (card d244e8fa)

Branch `tsubaki/ava-vnext-w6-hindsight-import`. Consumes the Rin-cleared
curated corpus (`~/staging/estate-migration/memory-curated/`, manifest
`curation-manifest-v1.2.json`) through the spec §5 12-step pipeline into the
W4 import contract.

## New modules (infra/hindsight/adapter/)
- `tier_contract.py` — frozen tier→contract-field projection; import order
  A-core→A-protected→A-wiki→B-daily→B-growth→B-other→C-flag→T-dreaming (LAST);
  D-suspect + D-ghost-window locked to the quarantine bank; bank router fails
  closed (active requires trust A/B).
- `corpus.py` — manifest loader (freeze hash, census validation) +
  manifest-ADDRESSED corpus reader (no directory walk, ever; byte/sha
  integrity per read: mismatch = quarantine + halt) + §6 normalization
  (canonicalization transform v1 = NFC + LF; source_time UTC + tz;
  content-keyed erasure keys so erasure cascades to replicas).
- `pipeline.py` — the 12 steps + hash-chained `ReceiptChain`. Checkpoints
  submitted→operation_complete→reconciled per batch via W4 ContractStore;
  hash mismatch = quarantine + HALT (no later batch starts); deterministic
  re-run (same manifest → same batch ids → same operation ids); one-batch
  rollback (append-only, zero target deletes); reconciliation = lineage both
  directions + zero orphan derived facts + 100% accounting identity.
- `gold_set.py` — provider-qualification gate (§8): deterministic 100-doc
  gold set from A-protected, ≥98% gold-fact recovery, 0 dropped chunks,
  strict schema, extraction errors FATAL; ingest refuses without a PASSED
  receipt. Optional live Ollama bge-m3 probe recorded best-effort.

## Additive W4 changes
- `import_contract.py`: optional `source_time_utc`/`source_tz` fields (§6
  binding field `source_time`); no behavior change otherwise (W4 suites stay
  green).
- `config.json`: additive `w6` block only.

## Running (fixtures/loopback — real-state apply is ORCHESTRATOR-owned)
```
python3 infra/hindsight/bin/qualify_gold_set.py --corpus-root <corpus> --out receipt.json
python3 infra/hindsight/bin/run_import_pipeline.py --corpus-root <corpus> --dry-run
python3 infra/hindsight/bin/run_import_pipeline.py --corpus-root <corpus> \
    --qualification receipt.json --out-dir /tmp/w6-receipts
```

## Tests (native unittest, single-file)
`python3 infra/hindsight/tests/test_<name>.py` — tier_contract,
corpus_manifest, pipeline_normalize, pipeline_dedup, pipeline_progressive,
pipeline_reconcile, gold_set_qualification (hermetic fixtures; w6fixtures.py
is the shared corpus/manifest builder).

## Evidence
Gold-set qualification + fixture-pipeline receipts land under
`infra/hindsight/evidence/w6/` and the card build dir on the build host.
