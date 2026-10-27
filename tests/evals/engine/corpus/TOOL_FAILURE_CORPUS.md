# Verified tool-failure corpus

This is corpus collection, not an eval result.

The version-1 PerfWatch index is a discovery source, not a verified case list.
`loadNewestToolFailureIndex(root)` selects the newest valid `YYYY-MM-DD` directory.
It reads `tool-errors.jsonl` and `digest.json` together. It does not fall back to an older day if the newest day is incomplete.
The reader returns accepted index rows and line-numbered rejections with named reasons.
Private index rows must not be copied into committed fixtures.

## Case format

`tool-failure-case.ts` owns the committed version-1 format.
Each case records:

1. A neutral unique ID and an incident-family key.
2. A category: failure recovery, wrong-tool success, guard, or ordinary work.
3. The decision-relevant tool set, neutral prior-message content, and the minimized call.
4. Required calls, forbidden tools, and the expected outcome.
5. Provenance: later success, a merged-fix URL, or an operator correction.
6. A neutral evidence key and a plain description of the observed proof.
7. The limits of the minimized case.

Keep transcript paths, session IDs, original prose, account names, and credentials in a private provenance map only.
Use neutral relative paths in fixtures. Never commit raw transcript extracts.
A later-success case includes the successful call and its minimized result.
An observed failure alone does not prove the expected outcome.
Several variants of the same incident keep the same family key.

## Evaluation boundary

Do not call `task-splits.ts` until exactly 100 unique verified cases exist.
Do not pad a short collection with invented incidents or variants.
Before freezing 100 cases, record a corpus hash and seed, then partition whole incident families into 20/20/60 sets.
A family must never span partitions. If the family sizes cannot satisfy those counts, collection must continue.
The existing split helper orders individual task IDs. It must not be used directly on related cases.
This change does not wire that helper, run a solver, score a model, or revise tool descriptions.

The consumer at https://github.com/Wladefant/superboard/issues/1470 receives evaluator outcomes only, not private transcripts or discovery rows.

## What the suite does not catch

Reader tests check the index boundary, newest-day selection, and digest consistency.
They do not prove trace authenticity, privacy completeness, tool availability, or causal fidelity after minimization.
They do not execute calls, exercise provider decoders, validate runtime tools, score model choices, or establish performance gains.
The collection report records the source coverage limits and each rejected-record reason.
