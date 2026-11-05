# Memory

By default, each session starts fresh: Veyyon holds no record of your last one. With memory on,
durable project context persists across sessions, so a fact recorded in one session is available in
the next. Memory is off by default. To use it, pick a backend, which is the store for recorded
memories, in `config.yml` or `/settings`.

## Backends

| Backend | Storage | Notes |
| --- | --- | --- |
| `off` | n/a | No memory injection or retention |
| `local` | Markdown under the agent memories dir (`MEMORY.md`, `memory_summary.md`, `skills/`) | Summaries from past session files |
| `mnemopi` | SQLite via `@veyyon/mnemopi` | Vector + FTS, auto-retain, compaction hooks |
| `hindsight` | Hindsight server (when configured) | Remote bank; retain/recall/reflect tools |
| `basic-memory` | Configured Basic Memory project | Optional, lexical recall and explicit retain tools |

Enable in config:

```yaml
memory:
  backend: basic-memory
  basicMemory:
    command: bm
    project: main
    configDir: ""
    timeoutMs: 60000
```
The default backend remains `off`. Basic Memory is opt-in and requires the pinned
`basic-memory==0.23.2` runtime. `memory.basicMemory.command` selects the executable
(default `bm`), `memory.basicMemory.project` selects the Basic Memory project
(default `main`), `memory.basicMemory.configDir` optionally selects its config
directory (empty uses Basic Memory's default), and `memory.basicMemory.timeoutMs`
sets the per-operation timeout (default 60000 ms, from 1000 to 300000 ms).
Project names map to Basic Memory project configuration; Veyyon does not create or
configure projects. Basic Memory must be installed and the selected project must
already be configured.

The four `memory.basicMemory.*` keys are config-only and do not appear in settings
screens. Set them in `config.yml`.

The integration starts `bm mcp --project <NAME>` from the session's working
directory and sets `BASIC_MEMORY_FORCE_LOCAL=true`. It reads and writes only the
configured project through the local MCP process. Imported source rows use the
`hindsight_source_base64:<base64-encoded JSON>` format; Veyyon decodes the row's
`text` (or supported legacy content field) for recall. Basic Memory does not
auto-inject mental models into the prompt. This remains a cutover blocker until
that behavior is available and verified.

Basic Memory recall uses lexical search. It does not promise semantic recall.
`reflect` returns source notes as evidence for the calling agent to synthesize;
the server does not generate the answer. Retention is explicit through the `retain`
tool. Veyyon does not auto-retain to Basic Memory.

### Mnemopi (recommended for long-running work)

With `memory.backend: mnemopi`, Veyyon:

1. Opens scoped SQLite banks (`global`, `per-project`, or `per-project-tagged`).
2. **Recalls** relevant memories into a `<memories>` block on the first turn, delivered as a message
   next to your prompt rather than by rewriting the cached system prompt.
3. **Retains** completed turns on a configurable interval (`mnemopi.retainEveryNTurns`, default 4).
4. Supplies **pre-compaction context** from the memory backend when compaction runs.

Settings: `mnemopi.scoping`, `mnemopi.recallLimit`, `mnemopi.autoRecall`, `mnemopi.autoRetain`,
`mnemopi.polyphonicRecall`, `mnemopi.noEmbeddings`. See
[`docs/internal/mnemosyne-memory-backend.md`](../../../internal/mnemosyne-memory-backend.md).

Dedicated tools when enabled: `recall`, `retain`, `reflect`, `memory_edit`.
The `/memory` slash command exposes `view`, `stats`, `diagnose`, `clear`, and `enqueue`.

### Local summary pipeline

With `memory.backend: local`, a background pipeline at startup extracts durable signal from past
session JSONL files, then consolidates into `MEMORY.md`, `memory_summary.md`, and optional
`skills/`. The agent reads artifacts via `memory://` URLs on the `read` tool.

Engineering detail: [`docs/handbook/src/architecture/memory.md`](../architecture/memory.md).

## Compaction (primary knobs)

Context compaction is separate from durable memory. Settings → Compaction (or `config.yml`) exposes
these primary fields:

| Setting | Key | Values |
| --- | --- | --- |
| Threshold | `compaction.threshold` | `auto`, a percent of the window (`85%`), or a token amount (`170000`) |
| Type | `compaction.strategy` | `summary`, the sole strategy |
| Model | `compaction.model` | model id; unset uses the interactive model |

`summary` rewrites old history into an in-place LLM summary. Run it on demand
with `/compact`. Use `/handoff` only when you explicitly want a new session. See
[Compaction and project memory](../context/compaction-memory.md).

## What the model receives

Recalled or summarized memory is **background context**, not instructions. Current user messages,
tool output, and repo state win on conflict. The agent should cite memory paths when memory changes
a plan and pair citations with fresh repo evidence.

It arrives in two places. The guidance that stays the same all session is part of the system prompt.
Anything that changes while you work, the memories recalled for your current question and the mental
models when they reload, arrives as a message next to your prompt instead.

The split reduces cost. The provider caches the system prompt as the prefix of every request;
changing it mid-session discards that cache, and the next request re-reads the whole conversation
at the uncached rate. The model receives the same text either way.

A block is sent once. A reload that finds the same memories sends nothing, so your context does not
grow by a copy of your memories every turn. `/memory view` shows both halves: the text the model
receives.

## Configuration

Use `/memory` or `/settings` (Memory group), or set keys under `memory.*`, `mnemopi.*`,
`hindsight.*`, or `memories.*` depending on the active backend.

The active backend, its settings, and its stored data are scoped to the active profile. Mnemopi and local memory write under the profile's own memories directory. A Hindsight bank id left unset is `veyyon` in the default profile and `veyyon-<profile>` in a named one, so profiles that share a Hindsight server keep separate banks. Set the same `hindsight.bankId` in two profiles to share one bank.
