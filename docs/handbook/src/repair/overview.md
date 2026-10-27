# Tool-call repair

Models often emit tool arguments that are almost valid JSON or almost match the tool schema: stringified objects, trailing commas, truncated payloads, or misnamed fields. Without a repair step those calls fail validation and cost a full turn.

Repair runs in the agent loop **before** argument validation. Clear malformations are coerced into a schema-valid object; ambiguous cases are rejected and returned to the model as an error tool result (no dispatch).

## Behavior

| Step | What it does |
| --- | --- |
| Seam | Runs at tool dispatch, before schema validation |
| Fix-if-clear | Trailing commas, parse sentinels (`__parseError` / `__rawJson`), stringified JSON objects |
| Leaked markup | A string value holding `</parameter><parameter name="k">` markup is split into its own arguments when every leaked name is declared (or `i`), new, and named once |
| Refuse-if-ambiguous | Missing required strings with multiple plausible sources → unrepairable |
| Alias / typo rename | Unknown keys that map unambiguously to a declared property are renamed; ambiguous renames are rejected |
| Strict unknown keys | Schemas with `additionalProperties: false` reject leftover keys after alias resolution |
| Tool-specific | `task` prose escaped twice is decoded; a `yield` `result` sent as a JSON string is parsed. Listed in `TOOL_ARGUMENT_REPAIRS` |
| Size bound | Inputs over 1 MiB are not repaired |
| Disable | `VEYYON_REPAIR_DISABLE=1`, or per-model `harness.profiles` with `repair: false`; both turn off tool-specific repairs too |

Implementation: `packages/coding-agent/src/tools/core/repair/schema-repair.ts`, with tool-specific repairs in `packages/coding-agent/src/tools/core/repair/tool-repairs.ts`  
Tests: `packages/coding-agent/test/edit/schema-repair.test.ts`, `packages/coding-agent/test/tools/a-tool-specific-argument-repair-reaches-approval-and-the-tool-as-one-set-of-arguments.test.ts`

## Related

- [The repair cascade](./cascade.md): ordered rules
- [Per-model posture](./per-model.md): harness profiles
- [Soundness and telemetry](./soundness.md)
- [The hashline edit engine](../edit/engine.md): edit path (separate from argument repair)
