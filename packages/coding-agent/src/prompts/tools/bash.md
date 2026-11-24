Runs commands in the embedded shell — terminal ops: git, bun, cargo, python.

# When to use bash — and when not to

This shell invokes **real binaries** with simple args, not full GNU Bash. Use it for one binary or a short pipeline that COMPUTES a fact without shell-specific regex or quoting (`wc -l`, `sort | uniq -c`, `comm`, `diff`, a checksum, `git status`).

For process cleanup, stop only a verified PID. The bash guard blocks common commands that stop processes by image name or pattern.

{{#if hasEval}}Anything below → `eval` cell, not bash:
- Inline interpreter scripts (`-e`/`-c`/`--eval`) when an eval runtime exists for that language
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell
{{else}}Anything below means you are writing a shell program, not invoking one. Prefer a purpose-built tool, a checked-in script, or a single repo command instead:
- Inline interpreter scripts (`-e`/`-c`/`--eval`)
- Heredocs (`<<EOF`), `while`/`for`/`if`/`case` shell control flow
- `$(…)` command substitution nested inside another command
- Pipelines with more than two stages, or stages that need control flow or quote/JSON escaping
- Multiline commands, `&&`-chains mixing control flow
- Quote/JSON escaping that fights the shell
{{/if}}
{{#if hasSearch}}- Workspace discovery belongs to `search`; use `type: "text"` for content and `type: "structure"` for code syntax.{{else}}- GNU grep BRE extensions are not guaranteed in the embedded shell; use `grep -E 'json|tool'` for alternation{{#if hasEval}}, or use `eval` for exact text processing{{/if}}.{{/if}}

<instruction>
- `env: { NAME: "…" }` for multiline / quote-heavy / untrusted values; reference `$NAME`
- Quote expansions (`"$NAME"`) to preserve exact content
- `pty: true` only when the command needs a real terminal (`sudo`, `ssh` needing input); default `false`
- `;` only when later commands should run despite earlier failures
- Multiple bash calls per message run concurrently. NEVER split order-dependent commands across parallel calls — chain with `&&` in one call.
- Internal URIs (`skill://`, `agent://`, …) auto-resolve to FS paths
{{#if hasEval}}- Need exact pipeline semantics (`cmd | head`, multi-stage filtering) or output truncation? Prefer `eval` and process the stream directly.{{else}}- Need exact pipeline semantics (`cmd | head`, multi-stage filtering) or output truncation? Use a checked-in script, purpose-built tool, or single command that owns the output shape.{{/if}}
{{#if asyncEnabled}}
- `async: true` defers reporting for finite commands that need no later input; completion arrives as a follow-up.
{{/if}}
</instruction>

<critical>
{{#unless hasEval}}
- Writing a shell program rather than invoking a binary? Use a purpose-built tool or checked-in script.
{{/unless}}
{{#if hasSearch}}
- `grep`/`rg`/`find`/`fd` are blocked for workspace discovery; use `search`. Use `read` for known files and directories when it is active.
{{else}}
- Avoid shelling out for broad workspace discovery when a purpose-built tool is active.
{{#if hasRead}}
- Prefer `read` for known file and directory reads. Keep shell discovery narrow.
{{else}}
- If no file read or search tool is active, keep shell inspection narrow and state that limitation.
{{/if}}
{{/if}}
- Avoid head/tail/redirections: stderr already merged; long output auto-truncated, FULL capture kept at `artifact://<id>`.
{{#if hasLaunch}}
- Ends on its own? bash, however long it runs{{#if asyncEnabled}} (`async: true` for a slow one){{/if}}. Runs until stopped, or needs later stdin? `launch` — NEVER `cmd &`, `nohup`, or async bash as a process supervisor.
{{/if}}
</critical>

<output>
- Returns output with stderr merged into stdout; a non-zero exit shows the exit code. Truncated output is linked as `artifact://<id>` in metadata.
</output>

{{#if asyncEnabled}}
# Timeout and async

- `timeout` is seconds, default 300; nonzero values are clamped to `1..3600` and the process is killed on elapse. Set `timeout: 0` only for a finite command whose completion is cancellation-owned.
- `async: true` defers only reporting; it does NOT extend a nonzero timeout.
{{#unless hasLaunch}}
- Need a long-running process or >3600s run? Use an external process supervisor; avoid detached shell jobs you cannot later observe or stop.
{{/unless}}
{{/if}}

## Backgrounding a foreground call
{{#if autoBackgroundEnabled}}

- A long call may background after {{autoBackgroundSeconds}}s or when the operator requests it. The result arrives later. Do not retry or wait synchronously.
- Need it inline? Raise `timeout` to match the command{{#if asyncEnabled}}, or set `async: true` to receive a follow-up{{/if}}.
{{/if}}
- `backgroundAfter` is seconds of foreground time for THIS call before it converts to a background job, overriding the configured default in both directions: raise it for a command whose output you need inline, lower it for one you know is slow. `backgroundAfter: 0` backgrounds immediately.
- NEVER poll a backgrounded job: no `sleep`, `pgrep`, `ps`, `tail -f`, `top`, and no second call that watches it. Do other work or end your reply — the finished job wakes you with its output.
{{#if stallDetectionEnabled}}

## Stall detection

- No output for {{stallSeconds}}s? The call backgrounds and reports a possible stall. Expected silence is normal; use `job` with `cancel: ["<jobId>"]` only for a real hang.
{{/if}}

# Output minimizer

- Long output is truncated and test/lint runner output filtered to failures. A `[raw output: artifact://<id>]` footer appears whenever visible text changed: read it if a run looks suspicious or you need exact bytes. No footer means you saw exactly what the command emitted.
