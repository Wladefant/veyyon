State: DONE.

Post-merge release completed for [PR #1059](https://github.com/Wladefant/veyyon/pull/1059) and prerequisite changelog [PR #1070](https://github.com/Wladefant/veyyon/pull/1070).

### Release Receipts

- **Release Version / Tag**: `v1.8.17` (tag points at `a769e3041978a61cf75c6028c19407a3361cb77c`)
- **Published Tag on Remote**: Verified via `git ls-remote origin refs/tags/v1.8.17` -> `a769e3041978a61cf75c6028c19407a3361cb77c`
- **Full Commit Lineage on main**:
  - `a769e3041978a61cf75c6028c19407a3361cb77c`: `chore: bump version to v1.8.17`
  - `db8dd1f57e47c0f3c4c0c2bb927a25217a9fa6cc`: Merge PR #1070 (`docs/changelog-1059`)
  - `e03c159e881b196f0ef46b6aa5ff19c98f6d49af`: PR #1070 commit
  - `fccaf3bdcdbff6749dd2b0f3d8f344f0788d2066`: Merge PR #1059 (`fix/read-selector-root-20261108`)
  - `31c8e4a8dab6028daa5bfd8424226497e84e5570`: PR #1059 head
- **OVH CI Verification Run**: Run ID `42561280961` (status: `completed`, conclusion: `success`, 34 pass, 0 fail on `a769e3041978a61cf75c6028c19407a3361cb77c`)
- **Installed Binary on Disk**:
  - Path: `C:\Users\wkiri\AppData\Local\veyyon\veyyon.exe`
  - Version: `veyyon/1.8.17 (a769e30419-local; build SHA a769e3041978a61cf75c6028c19407a3361cb77c)`
  - SHA256: `2d52885950f80f3d2549a468db05be1575462e6a0641334216849456b2749517`
- **Rollback Binary**:
  - Path: `C:\Users\wkiri\AppData\Local\veyyon\veyyon.20261109T044400Z.28480.rollback.exe`
  - Version: `veyyon/1.8.16 (ff83095474-local; build SHA ff83095474328d55c1c25f528afd127247640e69)`
- **Startup Gate**:
  - Verified twice during install without error markers.
  - Manual verification `veyyon.exe usage --json` returns valid JSON with zero error markers.
- **System Version Record**:
  - URL: https://github.com/Wladefant/veyyon-system/commit/40ccae1c3ae82b81cb156d3f41d8ca20b269c342
- **Running Main vs Installed Binary**:
  - Installed binary on disk is updated to v1.8.17 (`a769e3041978a61cf75c6028c19407a3361cb77c`).
  - Active Main process remains running on its pre-existing in-memory load; no restart was performed.
- **Defect Scope**:
  - PR #1059 fixes NTFS stream selector fallback in `path-utils.ts` on Windows.
  - Separate `local://` semicolon routing remains distinct and unaddressed.
- **Worktree Retention**:
  - Guarded remover `wt_remove.py` on `C:/Users/wkiri/development/veyyon-wt/docs-changelog-1059` returned a precise refusal (`process scan could not verify every process; enumeration failed or an unreadable process exists` due to Windows system processes). Worktree is safely retained without bypassing unknown-process protection.
