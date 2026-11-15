State: Fixed all three review findings (Finding 1 [P1], Finding 2 [P2], Finding 3 [P2]) on exact head `1d4911dda8874904eb076f9fb65f9da369b46443`.

This comment replies to review [5825111619](https://github.com/Wladefant/veyyon/pull/1072#pullrequestreview-5825111619). It documents the fixes, commit links, test outcomes, and package type diagnostics.

### 1. Response to Finding 1 [P1] \u2014 Retirement barrier and detached send side effects
- **Issue:** A broker retirement broadcast could leave in-flight detached `send` operations active. Clients would discard the socket on `broker-retiring` and replay commands to the replacement broker. This could trigger duplicate signals or I/O.
- **Fix:** Added an explicit retirement barrier and atomic commit serialization in `packages/coding-agent/src/launch/broker.ts`. The broker checks `#shuttingDown` before and after asynchronous dispatch boundaries. It answers or rejects accepted detached operations before broadcasting `broker-retiring`.
- **Commits:**
  - `6d252869313d085f52fc091cf2db055661252374`: `fix(launch): close guarded retirement races` ([commit 6d25286](https://github.com/Wladefant/veyyon/commit/6d252869313d085f52fc091cf2db055661252374))
  - `72cec8e0e1080cfcab1f34bed373242e7e6d5386`: `fix(test): correct marker newline and snapshot narrowing in guarded-retirement test` ([commit 72cec8e](https://github.com/Wladefant/veyyon/commit/72cec8e0e1080cfcab1f34bed373242e7e6d5386))
  - `e46c23ac548239307ee05fba68d38399ad051669`: `fix(test): align fs.stat spy signature with overload types` ([commit e46c23a](https://github.com/Wladefant/veyyon/commit/e46c23ac548239307ee05fba68d38399ad051669))
- **Regression test:** Added `packages/coding-agent/test/launch/guarded-retirement-and-readiness.test.ts` (test case: `replies to accepted detached sends before retirement notice`).

### 2. Response to Finding 2 [P2] \u2014 Guarded send blocked during readiness wait
- **Issue:** `#serialized(name, ...)` serialized `send`. This blocked guarded stdin input when `start` awaited a readiness log banner.
- **Fix:** Scoped lifecycle serialization around incarnation-changing admission and launch commits in `packages/coding-agent/src/launch/broker.ts`. It does not hold the lock across asynchronous readiness delays. Safe matching-generation `send` operations execute while start readiness is pending.
- **Commit:** `6d252869313d085f52fc091cf2db055661252374` ([commit 6d25286](https://github.com/Wladefant/veyyon/commit/6d252869313d085f52fc091cf2db055661252374)).
- **Regression test:** Added `packages/coding-agent/test/launch/guarded-retirement-and-readiness.test.ts` (test case: `allows a guarded send to satisfy readiness while start waits`).

### 3. Response to Finding 3 [P2] \u2014 Rejected guarded stop/restart canceled exit watcher
- **Issue:** `LaunchTool.execute` invoked `releaseLaunchExitWatch` before parameter validation and broker confirmation. A rejected guarded `stop` or `restart` canceled the background exit watch for the surviving process.
- **Fix:** Gated watcher cancellation in `packages/coding-agent/src/tools/shell/launch.ts` and `packages/coding-agent/src/tools/shell/launch-exit-watch.ts`. The watcher cancels only when broker execution succeeds for the target incarnation. Rejection keeps the existing watcher active.
- **Commits:**
  - `6d252869313d085f52fc091cf2db055661252374`: Initial watcher outcome gating.
  - `1d4911dda8874904eb076f9fb65f9da369b46443`: `fix(launch): gate watcher notification on stop/restart outcome and preserve on rejection` ([commit 1d4911d](https://github.com/Wladefant/veyyon/commit/1d4911dda8874904eb076f9fb65f9da369b46443))
- **Regression tests:** Expanded `packages/coding-agent/test/tools/a-launched-process-that-ends-reports-its-exit.test.ts` with 7 dedicated rejection and replacement test cases.

---

### Verification and Test Counts

1. **Red-to-Green Transition:**
- **Prior review head (`7ff96c2aba5f87d2caecc7c3f688b8ad4bff7926`):**
  - Finding 1: Uncovered. Accepted detached send raced with retirement broadcast.
  - Finding 2: Uncovered. Guarded send deadlocked behind pending readiness start.
  - Finding 3: Uncovered. Stale/invalid stop or restart silently dropped exit watch.
- **Exact pushed head (`1d4911dda8874904eb076f9fb65f9da369b46443`):**
  - Ran five focused test files through `build_slot` (`medium`, WSL bwrap prepared deps):
    - `packages/coding-agent/test/launch/guarded-protocol.test.ts` (21 pass)
    - `packages/coding-agent/test/launch/guarded-control-never-follows-a-replacement.test.ts` (8 pass)
    - `packages/coding-agent/test/launch/guarded-retirement-and-readiness.test.ts` (2 pass)
    - `packages/coding-agent/test/tools/a-launched-process-that-ends-reports-its-exit.test.ts` (13 pass)
    - `packages/coding-agent/test/launch/a-broker-with-nothing-to-supervise-retires-while-clients-stay-connected.test.ts` (5 pass)
  - **Result: 49 pass, 0 fail, 242 expect() calls across 5 files (exit 0).**

2. **Full Package Type Check Diagnostics (`bun run --cwd packages/coding-agent check:types`):**
- Result: 5 diagnostics, exit code 1.
- Exact diagnostics:
  - `test/task/task-spawn-executor-cwd.test.ts(67,16): error TS18048: 'options' is possibly 'undefined'.`
  - `test/task/task-spawn-executor-cwd.test.ts(67,16): error TS18048: 'options.sessionManager' is possibly 'undefined'.`
  - `test/task/task-spawn-executor-cwd.test.ts(137,47): error TS18048: 'options' is possibly 'undefined'.`
  - `test/task/task-spawn-executor-cwd.test.ts(138,47): error TS18048: 'options' is possibly 'undefined'.`
  - `test/task/task-spawn-executor-cwd.test.ts(138,47): error TS18048: 'options.sessionManager' is possibly 'undefined'.`
- **Baseline proof:** `test/task/task-spawn-executor-cwd.test.ts` has identical content across base `main` (`a769e3041978a61cf75c6028c19407a3361cb77c`), review head `7ff96c2aba5f87d2caecc7c3f688b8ad4bff7926`, and exact head `1d4911dda8874904eb076f9fb65f9da369b46443` (commit `cc5ab23bb37aaba41a9b187868132f2c8daaabad`). `git diff` against base and review head shows zero changes in this file. Zero diagnostics originate from changed launch files.
