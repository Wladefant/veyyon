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
2. **Symlinks:** Symbolic links are rejected. All synced items must be regular files.
3. **Database Files:** SQLite files (`.db`, `.db-wal`, `.db-shm`, `.sqlite`, `.sqlite3`) are strictly forbidden. Per SQLite Write-Ahead Logging specifications, WAL shared memory requires all processes to be on the same host; database files must never be replicated as raw text assets.
4. **Secrets and Credentials:** Files named `.env`, `credentials.json`, `id_rsa`, `*.pem`, `*.key`, or paths under `shared-auth/` are strictly rejected. Content containing API keys or private keys is rejected.
5. **Runtime Files:** Transient files (`*.sock`, `*.pid`, `*.lock`, `*.log`, `node_modules/`, `__pycache__/`, `cache/`, `logs/`, `run/`, `ipc/`) are excluded.

## Manifest Hashes and 3-Way Baseline Comparison

Catalogs include a `manifest.json` recording SHA-256 digests for all items.

When applying an incoming catalog, Veyyon performs a three-way comparison against the local target and the last-applied baseline (`.knowledge-baseline.json`):

- **Clean Create:** File does not exist locally and was not in the baseline. Safe to create.
- **Unchanged:** Local target hash matches incoming catalog hash. No-op.
- **Clean Update:** Local target matches the baseline (unmodified locally) and upstream has changed. Safe to update.
- **Divergent Edit (Conflict):** Local target was modified locally and incoming catalog differs, or target exists without a baseline.
- **Clean Delete:** Item was deleted upstream and local target is unmodified from baseline. Safe to remove.

### Conflict Preservation and Atomicity

When a divergent edit is detected:
1. **Refuse Overwrites:** The synchronization operation refuses to overwrite any target file.
2. **Preserve Both Inputs:** The local target file remains completely untouched. When conflict preservation is enabled, the incoming conflicting version is written alongside the target as `<targetPath>.conflict.<sha>` so no edits are lost.
3. **No Partial Application:** Pre-flight validation checks all files before making any writes. If a single item has a conflict or validation error, zero files are written to the target directory.

## Hindsight Remote Memory Reference

When sharing memory configuration:
- The catalog exports Hindsight reference settings (`apiUrl`, `bankId`, `scoping`, `bankMission`, `autoRecall`, `autoRetain`).
- **No Credentials:** API tokens (`apiToken`) and authentication secrets are strictly excluded.
- **No Database Migration:** Mnemopi databases and SQLite tables are not migrated or overwritten. Each PC maintains its local runtime while sharing the remote Hindsight memory authority.

## CLI Commands

### Export

Export local text knowledge assets into a versioned catalog directory:

```bash
veyyon knowledge export --out ./knowledge-catalog
```

Filter by specific categories:

```bash
veyyon knowledge export --out ./knowledge-catalog --categories skills,rules
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
