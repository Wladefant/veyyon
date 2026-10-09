# 0004. The kernel names no tool and no host

Status: accepted

## Context

The kernel package holds the plugin loader, the contribution registry, and the session spine. If the kernel imports tools, hosts, or high-level agent packages, circular dependencies arise across workspace members.

## Decision

The kernel follows a strict dependency direction. It may name contracts, shared runtime packages (`@veyyon/agent-core`, `@veyyon/ai`, `@veyyon/catalog`, `@veyyon/utils`), and platform builtins. It must not import any tool, host, mode, or `@veyyon/coding-agent`.

## Consequences

- Workspace members remain decoupled.
- Plugins register capabilities into the contribution registry rather than hardcoding kernel links.
- The boundary is enforced by test suites.

Evidence: [`ARCHITECTURE.md`](../../ARCHITECTURE.md) ("The kernel follows a strict dependency direction"), [`scripts/the-kernel-names-no-tool-and-no-host.test.ts`](../../scripts/the-kernel-names-no-tool-and-no-host.test.ts).
