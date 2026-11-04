# Shared Text Knowledge Synchronization

Synchronize reviewed text knowledge assets (skills, lessons, managed skills, rules, workflows, and reviewed configuration) across multiple workstations (such as an operator's two PCs) using private Git catalogs or export bundles.

Text knowledge sync operates independently of session execution, live attach, or auth storage: it transfers reviewed text instructions and procedural knowledge without copying runtime processes, active databases, or credentials.

## Overview

Text knowledge is organized into six categories:

| Category | Location | Purpose |
| --- | --- | --- |
| `skills` | `agent/skills/` | Authored skills created or edited by the operator |
| `managed-skills` | `agent/managed-skills/` | Auto-learned procedural skills |
| `lessons` | `agent/memories/learned.md` | Durable facts and lessons captured via the learn tool |
| `rules` | `agent/rules/`, `agent/AGENTS.md`, `agent/RULES.md`, `~/.veyyon/AGENTS.md` | Instruction layers and TTSR stream rules |
| `workflows` | `~/.veyyon/workflows/` | Reviewed multi-agent workflow scripts and manifests |
| `config` | `config/hindsight-reference.json` | Reviewed configuration reference (e.g. shared Hindsight authority) |

## Precedence: Authored over Managed

Authored skills strictly take precedence over managed skills:
- If a skill with the same name exists in both `skills/` and `managed-skills/`, the authored version is preferred.
- An incoming managed skill cannot overwrite an existing local authored skill.
- When an incoming catalog contains both an authored and a managed version of a skill, the authored version applies and the managed version is shadowed.

## Security Allowlist and Rejections

To protect machine security and prevent secret leakage:

1. **Path Traversal:** Any relative path containing `..`, leading slashes, Windows drive letters, UNC paths, or null bytes is rejected.
2. **Symlinks:** Source and target paths reject symlinks, junctions, canonical aliases, and symlink ancestors. Targets must remain within their managed root.
3. **Database Files:** SQLite files (`.db`, `.db-wal`, `.db-shm`, `.sqlite`, `.sqlite3`) are strictly forbidden. Per SQLite Write-Ahead Logging specifications, WAL shared memory requires all processes to be on the same host; database files must never be replicated as raw text assets.
4. **Secrets and Credentials:** Credential files and common credential patterns are rejected. The scanner cannot detect every secret. Keep credentials in Bitwarden US and review every planned file before export.
5. **Runtime Files:** Transient files (`*.sock`, `*.pid`, `*.lock`, `*.log`, `node_modules/`, `__pycache__/`, `cache/`, `logs/`, `run/`, `ipc/`) are excluded.

## Manifest Hashes and 3-Way Baseline Comparison

Catalogs include a `manifest.json` recording SHA-256 digests for all items.

When applying an incoming catalog, Veyyon performs a three-way comparison against the local target and the last-applied baseline (`.knowledge-baseline.json`):

- **Clean Create:** File does not exist locally and was not in the baseline. Safe to create.
- **Unchanged:** Incoming matches the local target, or incoming remains at the baseline while only the local target changed. Preserve local edits.
- **Clean Update:** Local target matches the baseline (unmodified locally) and upstream has changed. Safe to update.
- **Divergent Edit (Conflict):** Local target was modified locally and incoming catalog differs, or target exists without a baseline.
- **Clean Delete:** An owned baseline item disappeared upstream and its local bytes remain unchanged. Preserve its original category and destination. Legacy baselines without ownership details cannot authorize deletion.

### Conflict Preservation and Atomicity

When a divergent edit is detected:
1. **Refuse Overwrites:** The synchronization operation refuses to overwrite any target file.
2. **Preserve Both Inputs:** The local target file remains completely untouched. When conflict preservation is enabled, the incoming conflicting version is written alongside the target as `<targetPath>.conflict.<sha>` so no edits are lost.
3. **Locked Transaction:** Apply holds exclusive root, baseline, and configuration locks during comparison and commit. It stages files in the same directory and restores backups after a write failure. An interrupted process leaves a journal; the next locked apply restores the prior state before comparison. Unlocked readers can observe replacements during commit.
4. **Dry Run:** Dry runs create no conflict copies and write no baseline.

## Hindsight Remote Memory Reference

When sharing memory configuration:
- The catalog exports Hindsight reference settings (`apiUrl`, `bankId`, `scoping`, `bankMission`, `autoRecall`, `autoRetain`).
- **No Credentials:** API tokens (`apiToken`) and authentication secrets are strictly excluded.
- **No Database Migration:** Mnemopi databases and SQLite tables are not migrated or overwritten. Each PC maintains its local runtime while sharing the remote Hindsight memory authority.

## CLI Commands

### Export

Create a candidate plan without exporting a catalog:

```bash
veyyon knowledge export --plan ./review-plan.json
```

Read every listed file and its path, category, and SHA-256 digest. Remove entries you do not approve from the plan.
Then export exactly the reviewed set:

```bash
veyyon knowledge export --out ./knowledge-catalog --reviewed-plan ./review-plan.json
```

Export refuses changed or missing reviewed files before it writes the catalog. It reports and skips files absent from the plan.
A real export without `--reviewed-plan` fails.

To plan only specific categories:

```bash
veyyon knowledge export --plan ./review-plan.json --categories skills,rules
veyyon knowledge export --out ./knowledge-catalog --reviewed-plan ./review-plan.json --categories skills,rules
```

### Apply / Import / Pull

Apply an exported catalog to the current profile:

```bash
veyyon knowledge apply --from ./knowledge-catalog
```

Or using the `pull` alias:

```bash
veyyon knowledge pull --from ./knowledge-catalog
```

### Diff / Status

Preview changes, updates, and potential conflicts without modifying files:

```bash
veyyon knowledge diff --from ./knowledge-catalog
```

Or for JSON output:

```bash
veyyon knowledge status --from ./knowledge-catalog --json
```

### Verify

Verify catalog integrity, check all SHA-256 hashes against files, and validate the security allowlist:

```bash
veyyon knowledge verify ./knowledge-catalog
```
