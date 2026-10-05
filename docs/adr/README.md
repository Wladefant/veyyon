# Architecture decision records

Each file records one decision that later work must not re-open without new evidence. The `improve-codebase-architecture` skill reads this directory and skips a candidate that contradicts an ADR, unless the friction justifies reopening it (the skill marks such a candidate "ADR conflict").

Format: `NNNN-short-title.md` with Status, Context, Decision, Consequences. Keep each to one screen. Add a record when a candidate is rejected for a load-bearing reason; skip ephemeral reasons. Domain nouns come from [`GLOSSARY.md`](../../GLOSSARY.md).

| ADR | Decision |
| --- | --- |
| [0001](0001-fork-from-oh-my-pi.md) | Fork oh-my-pi rather than build from scratch |
| [0002](0002-typescript-bun-not-rust.md) | Keep the product in TypeScript + Bun; Rust for hot paths only |
| [0003](0003-reset-versioning-to-1.0.0.md) | Reset veyyon's release line to 1.0.0 above the fork point |
| [0004](0004-kernel-names-no-tool-and-no-host.md) | The kernel names no tool and no host |
