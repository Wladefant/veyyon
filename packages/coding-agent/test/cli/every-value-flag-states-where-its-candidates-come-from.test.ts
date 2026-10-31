/**
 * Every flag that takes a value either completes from a named source or is recorded as free text.
 *
 * WHY THIS SUITE EXISTS. `completion-gen.ts` classifies a flag's value by its name, and a name missing
 * from every table falls through to `{ kind: "value" }`: the shell offers nothing. That fall-through is
 * correct for a secret or a free-text prompt and wrong for a model selector, and nothing distinguished
 * the two. `--compaction-model` takes the same model selector as `--model`, `--plan` and `--prewalk-into`,
 * yet `veyyon --compaction-model <TAB>` completed nothing because the flag was added after the table was
 * written. `--prewalk-into` and `--plan-yolo-into` had the same defect before it.
 *
 * The class is "a value flag nobody classified". The sweep walks every flag of every registered command,
 * through the same `buildSpec` the shells are generated from, and pins the flags that complete nothing by
 * exact equality. A new value flag turns the suite red until its author either names its candidate
 * source in `completion-gen.ts` or adds it here as free text.
 *
 * NOT CAUGHT: a flag classified into the WRONG source (a model flag listed as a file). The tables are
 * keyed by name and checked against real flags elsewhere; whether a source fits a flag is a judgement
 * this suite records rather than makes.
 */

import { describe, expect, it } from "bun:test";
import { buildSpec } from "@veyyon/coding-agent/cli/completion-gen";
import { commands } from "@veyyon/coding-agent/cli-commands";
import type { CliConfig, CommandCtor } from "@veyyon/utils/cli";

const ctors = new Map<string, CommandCtor>();
for (const entry of commands) {
	ctors.set(entry.name, (await entry.load()) as CommandCtor);
}

/** The spec every shell script is generated from, over the real registered commands. */
const spec = buildSpec({ bin: "veyyon", version: "0.0.0", commands: ctors } as CliConfig, "launch", new Map(), {});

/** `<command> --<flag>` for every flag of the real CLI, with the source it completes from. */
const flagKinds: ReadonlyArray<readonly [string, string]> = [
	...spec.root.flags.map(flag => [`launch --${flag.name}`, flag.value.kind] as const),
	...spec.commands.flatMap(command =>
		command.flags.map(flag => [`${command.name} --${flag.name}`, flag.value.kind] as const),
	),
];

/**
 * Value flags with no candidates: secrets, free text, numbers, addresses and names only the caller knows.
 * Adding a flag here is a decision that tab completion offers nothing for it.
 */
const FREE_TEXT_FLAGS = [
	"auth-broker --bind",
	"auth-broker --provider",
	"auth-broker --via",
	"auth-gateway --bind",
	"bench/throughput --max-tokens",
	"bench/throughput --par",
	"bench/throughput --prompt",
	"bench/throughput --runs",
	"commit --context",
	"dry-balance --concurrency",
	"dry-balance --count",
	"gallery --theme",
	"gallery --tool",
	"gallery --width",
	"gc --cold-archive-after-days",
	"gc --retain-newest-global",
	"gc --retain-newest-per-cwd",
	"gc --write-grace-minutes",
	"grep --context",
	"grep --glob",
	"grep --limit",
	"grievances --id",
	"grievances --limit",
	"grievances --tool",
	"launch --alias",
	"launch --api-key",
	"launch --max-time",
	"launch --profile",
	"launch --prompt-cache-key",
	"launch --provider",
	"launch --provider-session-id",
	"launch --skills",
	"launch --system-prompt",
	"plugin --disable",
	"plugin --enable",
	"plugin --set",
	"profile --from",
	"prompt --prompt",
	"prompt --section",
	"prompt --statement",
	"search --limit",
	"shell --timeout",
	"ssh --desc",
	"ssh --host",
	"ssh --port",
	"ssh --user",
	"stats --port",
	"token --account",
	"ttsr --max-bytes",
	"ttsr --tool",
	"usage --days",
	"usage --provider",
];

describe("every value flag states where its candidates come from", () => {
	it("completes nothing only for the flags recorded as free text", () => {
		const unclassified = flagKinds
			.filter(([, kind]) => kind === "value")
			.map(([flag]) => flag)
			.sort();

		expect(unclassified).toEqual(FREE_TEXT_FLAGS);
	});

	/** The reported flag, by name: a summarizer model completes from the same catalog as the session model. */
	it("completes --compaction-model from the model catalog like --model", () => {
		const kinds = new Map(flagKinds);

		expect(kinds.get("launch --compaction-model")).toBe("models");
		expect(kinds.get("launch --model")).toBe("models");
	});

	/** Anti-vacuity: the sweep read the real command table, root flags included. */
	it("sweeps the real command table", () => {
		expect(ctors.size).toBeGreaterThan(20);
		expect(spec.root.flags.length).toBeGreaterThan(30);
		expect(flagKinds.length).toBeGreaterThan(150);
	});
});
