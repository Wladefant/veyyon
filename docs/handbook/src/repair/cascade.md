# The repair cascade

Before argument validation, the agent loop runs `packages/coding-agent/src/tools/core/repair/schema-repair.ts` in this order:

1. **Parse leniency**: trailing commas / relaxed JSON; stringified argument blobs.
2. **Leaked parameter markup**: a string value holding `</parameter><parameter name="k">` markup is cut at the markup, and the text after each tag becomes argument `k`: `language: 'py</parameter>\n<parameter name="title">imports'` becomes `language: "py"`, `title: "imports"`. The value is split only when every leaked name is a declared property or `i`, appears once, and is absent from the call, and no part holds further markup; otherwise the value is left as sent.
3. **Alias / typo key rename**: unknown keys that match a common alias (`filepath` → `path`, `contents` → `content`) or a casing/separator typo of a declared property are renamed to the declared name. The rename is rejected when it would be ambiguous (two unknown keys map to the same property, one unknown key matches more than one declared property, or the alias target already has a value).
4. **Tool-specific repair**: the tool's entry in `TOOL_ARGUMENT_REPAIRS` (`packages/coding-agent/src/tools/core/repair/tool-repairs.ts`) runs, when the tool has one and the call carries the mistake it repairs. See [Tool-specific repairs](#tool-specific-repairs).
5. **Strict unknown-key rejection**: when the tool schema declares `additionalProperties: false`, any key left after alias resolution is rejected rather than dropped or passed through.
6. **Ambiguity check**: reject when required string fields have multiple plausible donors.
7. **Outcome**: `clean`, `repaired` (canonical args + hints), or `unrepairable` (error tool result, no dispatch).

Validation, approval, the tool, the `tool_execution_*` events and every hook receive the arguments the cascade returns.

Conformance suite: `packages/coding-agent/test/edit/schema-repair.test.ts` (alias renames, ambiguity refusals, strict-mode refusals, and a check that strict rejection does not fire on ArkType/Zod wire schemas that synthesize `additionalProperties: false` for closed-object emission rather than authorial strictness).

## Tool-specific repairs

| Tool | Fields rewritten | Mistake repaired |
| --- | --- | --- |
| `task` | `task`, `context`, `tasks[].task` | Prose the model JSON-escaped twice, which arrives with literal `\n`, `\"` and `\u2014` sequences in place of newlines, quotes and characters. Decoded once. |
| `yield` | `result` | The `result` wrapper sent as a JSON string: `"{\"data\": {…}}"`. Parsed into its object. |

An entry rewrites only the fields it lists, and only when the call has one reading. A value that would decode twice, which is either encoded three times or quotes escapes of its own, is left as sent. A field longer than 1,048,576 UTF-16 code units is left as sent. Repairing an entry's output again changes nothing.

These are not argument repair and stay in their tools:

- `search` ignores a field its selected type does not accept and lists it in the result.
- A URL that `read` loads has a scheme collapsed by path normalization restored: `https:/host` becomes `https://host`.
- Path resolution in the file tools (`expandPath` and `resolveReadPath` in `packages/coding-agent/src/tools/core/path-utils.ts`) drops a stray leading `:`, or a leading `@` before an absolute path, `~` or an internal URL, maps Unicode spaces to ASCII spaces and reads a `file://` URL as its path. A read of a path that does not exist uses the shell-unescaped, NFD, curly-apostrophe or macOS screenshot spelling that does.
- The task renderer decodes the streamed brief for the preview. Execution receives the brief from the `task` entry.

Suite: `packages/coding-agent/test/tools/a-tool-specific-argument-repair-reaches-approval-and-the-tool-as-one-set-of-arguments.test.ts`.

Per-model enable/disable and tool allowlist hints: [Per-model posture](./per-model.md).

## Related

- [Why repair exists](./overview.md)
- [Repair on edits](../edit/edit-repair.md)
