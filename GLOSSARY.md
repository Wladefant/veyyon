# Glossary

Domain nouns for veyyon. The `improve-codebase-architecture` and `codebase-design` skills read this file, so candidate titles and review findings use these words. Design vocabulary (module, interface, depth, seam, adapter, leverage, locality) belongs elsewhere, not here.

| Term | Meaning | Where |
| --- | --- | --- |
| **Lane** | A background worker process that executes isolated subagent tasks. | [`packages/coding-agent/src/task/agents.ts`](packages/coding-agent/src/task/agents.ts), [`packages/coding-agent/src/task/executor.ts`](packages/coding-agent/src/task/executor.ts) |
| **Session** | The append-only record of conversation turns, model calls, and tool results. | [`contracts/session/src/index.ts`](contracts/session/src/index.ts), [`packages/agent/src/agent.ts`](packages/agent/src/agent.ts) |
| **Profile** | An isolated user configuration space for model pins, credentials, and settings. | [`packages/coding-agent/src/commands/profile.ts`](packages/coding-agent/src/commands/profile.ts), [`docs/handbook/src/features/profiles.md`](docs/handbook/src/features/profiles.md) |
| **Provider** | An upstream model API endpoint that streams chat completions to the harness. | [`packages/ai/src/api-registry.ts`](packages/ai/src/api-registry.ts), [`docs/handbook/src/architecture/providers.md`](docs/handbook/src/architecture/providers.md) |
| **Model role** | A configurable routing alias that maps logical responsibilities to specific models. | [`packages/coding-agent/src/config/model-roles.ts`](packages/coding-agent/src/config/model-roles.ts), [`docs/handbook/src/router/role-routing.md`](docs/handbook/src/router/role-routing.md) |
| **Task tool** | The built-in subagent dispatcher that executes worker tasks under resource limits. | [`packages/coding-agent/src/task/index.ts`](packages/coding-agent/src/task/index.ts), [`packages/coding-agent/src/prompts/tools/task.md`](packages/coding-agent/src/prompts/tools/task.md) |
| **Hindsight memory** | Long-term associative memory that persists semantic facts across distinct sessions. | [`packages/coding-agent/src/memory/hindsight/bank.ts`](packages/coding-agent/src/memory/hindsight/bank.ts), [`packages/coding-agent/src/memory/hindsight/index.ts`](packages/coding-agent/src/memory/hindsight/index.ts) |
| **Tool view** | A host-agnostic presentation model describing tool outputs for terminal and GUI renderers. | [`contracts/view/src/index.ts`](contracts/view/src/index.ts), [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| **Argot** | A lossless prompt-compression codec operating over project shorthand dictionaries. | [`plugins/argot/src/index.ts`](plugins/argot/src/index.ts), [`AGENTS.md`](AGENTS.md) |
| **Hashline** | A line-anchored patch language that applies safe surgical file edits with snapshot tags. | [`plugins/hashline/src/index.ts`](plugins/hashline/src/index.ts), [`AGENTS.md`](AGENTS.md) |
| **Mnemopi** | An embedded SQLite memory engine that stores relationship triples and embeddings. | [`plugins/mnemopi/src/index.ts`](plugins/mnemopi/src/index.ts), [`AGENTS.md`](AGENTS.md) |
| **Compaction** | Pruning and summarization of older session turns to maintain context budget. | [`packages/agent/src/compaction.ts`](packages/agent/src/compaction.ts), [`kernel/src/session/agent-session-compaction-policy.ts`](kernel/src/session/agent-session-compaction-policy.ts) |
| **Differential rendering** | A terminal display technique that repaints only changed cells to prevent flicker. | [`hosts/terminal/engine/src/index.ts`](hosts/terminal/engine/src/index.ts), [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| **Contribution registry** | The kernel registry where plugins register tools, commands, views, and schemas. | [`kernel/src/registry/tool-proxy.ts`](kernel/src/registry/tool-proxy.ts), [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| **Model catalog** | The bundled repository of provider configurations, model limits, and capability flags. | [`packages/catalog/src/index.ts`](packages/catalog/src/index.ts), [`ARCHITECTURE.md`](ARCHITECTURE.md) |
| **Tool contract** | An interface specification that defines tool parameters, permissions, and result types. | [`contracts/tool/src/index.ts`](contracts/tool/src/index.ts), [`AGENTS.md`](AGENTS.md) |
