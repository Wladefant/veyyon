# Experiments

An experiment compares arms: a baseline and one or more candidates that differ in one thing. The
evals run every arm on the same tasks with the same seeds in one plan, and report the difference with
its uncertainty. Choosing what to try is a person's call; the evals make the trial cheap and the
verdict honest.

## What an arm can vary

| Arm | Flag | Example |
|---|---|---|
| a build of the agent | `--build` | `--build main=/src/veyyon-main,head=.` |
| settings | `--config` | `--config arms/baseline.yml,arms/candidate-bash-trim.yml` |
| prompt text | `--prompts` | `--prompts terse.yml`, a YAML map of prompt id to replacement text |
| the model | `--model` | `--model provider/a,provider/b` |
| the harness | `--harness` | `--harness veyyon,omp` |

`arms/` holds settings overlays. An overlay changes one variable against the defaults, so a
difference has one cause. Companion files beside `<name>.yml` override system prompt sections
(`<name>.sections.yml`), statements (`<name>.statements.yml`), registered prompts
(`<name>.prompts.yml`), or mount a rule file (`<name>.rule.md`), on the backends that apply them.


## Skill outcome experiments

The manifest is version 1. It names one skill, its SHA-256 source hash, full content, and separable
component spans. The engine builds a baseline arm, a full arm, and one ablation per component. Skill
experiments run only through the in-process Veyyon backend.

Before a skill trial calls its provider, the SDK session reads and edits a disposable canary with
its real tools and isolated settings. The canary preserves the session's generated-file protection
value. A failed canary is an invalid setup, not a model-quality failure. Its startup exception
becomes an infrastructure error. The backend records the successful canary receipt with the trial.
Keep invalid original records unchanged and store a separate invalidity verdict. Never use their
feedback, candidate, or score artifacts to learn or select a revision. A source fix requires a new
binding and fresh feedback and score runs before the one-use final phase.

Use `--skill-phase pilot` with `--tasks <id>` or `--limit 1|2` to run a diagnostic against one or two
real tasks. Pilot arms are baseline, full, and component ablations. Pilot results are not eligible
for candidate selection or cutover.

Outcome-based tuning uses a manifest-declared cohort of either 100 verified, unique tasks or the
authorized 80-task skill cohort. The default split remains 20 feedback, 20 score, and 60 final tasks.
Only a manifest that declares `"cohortSize":80` enables the 16/16/48 split; an undeclared 80-task
corpus is rejected. Never invent tasks to fill a smaller corpus.

The run records `metadata.skillBinding`, the exact task split, frozen arms, and observed model and
loaded-skill hashes. The suite must provide exactly the declared task count and a nonempty corpus SHA.
Run the private workflow from the repository root with `bun tests/evals/evals.ts`. The authorized
80-task manifest and real descriptors are under `tests/evals/.cache/skill-outcome-pilot/`. The
manifest declares `"cohortSize":80` and `"criteria":{"minimumImprovement":0}`.

Generate a candidate from the verified feedback run:

```sh
bun tests/evals/evals.ts skill revise --manifest <manifest.json> --tasks <80-task-json> \
  --run <feedback-run.json> --split-seed <seed> --model <requested-model> --output <candidate.json>
```

The revision client receives only feedback task ids and their graded outcomes. It receives no task
bodies, score outcomes, or final outcomes. It runs the real in-process model client. It writes an
immutable candidate artifact and never installs the skill. The artifact binds the source, corpus,
split, predeclared criterion, run-source hashes, requested and resolved model identity, and exact
candidate content hash. An unknown model version stays unknown.
Use `bun tests/evals/evals.ts skill inspect --run <run.json> --manifest <manifest.json>` to compare a
run with current source and suite bindings. For a run that used a candidate, pass
`--candidate <candidate.json>` to verify the current candidate body and hash. Without that artifact,
inspection reports `unverified`; it never treats candidate details copied from the run as current
evidence.

Run `--skill-phase score` with the same seed, manifest, and candidate. It executes the full arm and
candidate arm on the 16 score tasks for the declared 80-task cohort (20 for the default 100-task
cohort). The manifest must declare `"criteria":{"minimumImprovement":<number>}` before feedback starts.
Create a frozen selection from the verified score run:

```sh
bun tests/evals/evals.ts skill select --manifest <manifest.json> --tasks <80-task-json> \
  --run <score-run.json> --split-seed <seed> --candidate <candidate.json> --output <selection.json>
```

Selection uses only complete score outcomes. Missing, erroneous, tied, or unknown-revision results
retain the incumbent. The selection records the score-run hash. Final use reads that same score run
and refuses a changed or mismatched receipt.

Final evaluation runs exactly the declared final set: 48 tasks for cohort 80, or 60 tasks for
cohort 100. Pass the frozen candidate, selection, and score run:

```sh
bun tests/evals/evals.ts --suite <suite> --model <model> --skill-experiment <manifest.json> \
  --skill-phase final --skill-split-seed <seed> --skill-candidate <candidate.json> \
  --skill-selection <selection.json> --skill-score-run <score-run.json>
```

A candidate winner runs the candidate arm. An incumbent winner runs the full arm. An unknown model
revision blocks candidate promotion, but it does not block a frozen incumbent final run. That run
reports the revision as unknown and unverified. Its once-only claim binds source, corpus, split,
resolved model identity, harness, and grader before any final work. An execution fingerprint also
binds the exact plan, task order, repeats, run id, directory, options, and cells. Claims survive
restart and failures. A process lock excludes concurrent use. Only an exact run resume can reuse a
claim.

## Running one

```sh
bun evals.ts --suite browser --model google-antigravity/gemini-3.8-flash \
  --build main=/src/veyyon-main,head=/src/veyyon --repeats 3 --jobs 4 --run-id browser-main-vs-head
```

- Arms run interleaved in one plan, so host load, network and provider conditions fall on each arm
  alike. Two runs made at different times are not a paired comparison.
- The same task and repeat get the same seed in every arm; a kit suite derives its data from that
  seed. Repeats get different seeds, so three repeats are three instances of each task.
- `--repeats` sets the sample. With a pass rate near the middle, a difference of a few tasks is inside
  the noise of one repeat.
- Use `--dry-run` first: it prints the variants and every preflight verdict.

## Reading the report

A kit suite writes `report.md` and `summary.json` into the run directory.

- **Arms**: passes, pass rate with its Wilson 95% interval, mean partial credit, errors (trials
  that never reached a grade), timeouts, and the tokens, turns and seconds spent.
- **Capability** and **Difficulty**: passes per capability and per difficulty, per arm.
- **Passes within turns, tokens, seconds**: how many trials passed within each budget of the
  suite's ladders, which `summary.json` records. An arm that passes the same tasks in fewer turns
  moves left on these curves while its pass rate holds.
- **Paired against the first arm**: over the task-and-repeat pairs both arms graded, the pairs only
  the candidate passed, the pairs only the baseline passed, the exact two-sided sign test p-value on
  those, and the change in tokens, turns and seconds summed over the pairs. A pair with an error on
  either side is left out, so an error never counts for or against one arm.

Tokens are every token the provider processed: input, cache reads and writes, and output.

`bun evals.ts tool kit-report --run runs/<run-id>` renders the report again, and `--regrade` first
grades every trial again from its `state.json` and `answer.txt` with the checks as they are now,
writing `report-regraded.md` and `summary-regraded.json` beside the run's own. A run copied to
another host is read from its trial directories under `--run`. The tool fails when the run
directory holds no readable `run.json`, since the arms' order, and so the baseline, comes from it.

## Rules that keep a result honest

- Compare arms from one run. Rerun both arms when one changes.
- Change one thing per arm.
- Read errors before pass rates. An arm with errors measured fewer trials than it planned.
- A sign test p-value above 0.05 is not a difference. Add repeats rather than tasks the arm was tuned
  on.
- Keep a held-out set: tasks nobody looked at while changing the agent. `--tasks` takes a list file.
