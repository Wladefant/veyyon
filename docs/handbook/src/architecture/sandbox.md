# Approvals

Approvals control when a tool or shell command runs without a prompt and when Veyyon pauses for the user.
There is no OS-level command sandbox: Veyyon does not confine commands with Landlock, seccomp,
Seatbelt, or bubblewrap. The boundary is policy the agent loop enforces before dispatch.

## Responsibility

- Map the **approval mode** (`tools.approvalMode`) to a per-tier decision (read / write / exec) for
  `bash`, `edit`, `write`, and related tools.
- Apply per-tool overrides (`tools.approval` → `allow` / `deny` / `prompt`) on top of the mode.
- Apply the two argument-level boundaries the tier cannot see: a filesystem target outside the session working directory, and a call whose arguments contain a stored credential. Both prompt on every rung except `yolo`, the shipped `auto` included.
- Refuse recognized direct recursive deletes in `bash` and `launch start`, before execution and independently of approval mode.
- Force a prompt for destructive bash risks not already denied, such as disk destruction, even in `yolo` without an explicit per-tool `allow`. Merely dangerous patterns (`curl | sh`, `reboot`, `nc -e`) prompt only below `yolo`.
- Show the approval prompt in the TUI before a command or edit that requires approval runs.

## Public boundary

`tools.approvalMode` in `config.yml` and the launch flags (`--approval-mode`, `--auto-approve` /
`--yolo`, `--plan-yolo`) resolve to a decision applied to the `bash`, `edit`, and `write` tools, with
plan-mode checks on top. Commands run **in-process** after policy resolution, there is no standalone
exec-server process in the shipped product.

## Concepts

| Concept | Meaning |
| --- | --- |
| Approval mode | Which tool tiers run without asking (`plan`, `ask`, `ask-command`, `auto` (default), `yolo`; legacy `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`). |
| Per-tool policy | `tools.approval` overrides the mode for a named tool. |
| Flagged bash patterns | Hard-coded command shapes recorded as destructive or dangerous. The destructive ones prompt on every rung including `yolo`, and below `yolo` a per-tool `allow` does not lift them. The dangerous ones prompt on every rung below `yolo`. |
| Plan mode | Restricts mutating tools until the plan is approved (`/plan`). |

User-facing guide: [Approvals](../features/sandbox.md).
