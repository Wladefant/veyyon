/**
 * A negative number is a value, not an option.
 *
 * `node:util`'s parseArgs reads any leading `-` as an option, so
 * `veyyon config set presencePenalty -1` died with "Unknown option '-1'" on a
 * value the setting accepts, and the only way through was the `-- "-1"` escape
 * hatch quoted in the error. Every numeric setting that takes a negative value
 * had the same hole: the presence and repetition penalties, and any future signed
 * amount.
 *
 * The fix masks negative-number tokens for the parse and restores them after, so
 * this suite pins both halves: negatives arrive intact wherever they appear, and
 * unknown-flag detection stays strict for everything that is genuinely a flag.
 */
import { describe, expect, it } from "bun:test";
import { Args, type CliConfig, Command, Flags, type ParseOutput } from "../src/cli";

const config: CliConfig = { bin: "veyyon", version: "0.0.0", commands: new Map() };

class ConfigLike extends Command {
	static args = {
		action: Args.string({ required: true }),
		key: Args.string(),
		value: Args.string(),
	};
	static flags = {
		json: Flags.boolean(),
		temperature: Flags.string(),
		limit: Flags.integer(),
	};
	// Typed from the descriptors rather than from `ReturnType<this["parse"]>`,
	// which is self-referential and collapses every flag back to `string`.
	parsed?: ParseOutput<typeof ConfigLike.flags, typeof ConfigLike.args>;
	async run(): Promise<void> {
		this.parsed = await this.parse(ConfigLike);
	}
}

async function parse(argv: string[]) {
	const cmd = new ConfigLike(argv, config);
	await cmd.run();
	return cmd.parsed as NonNullable<ConfigLike["parsed"]>;
}

describe("a negative number as a positional", () => {
	it("reaches the command as the value it is", async () => {
		const { args } = await parse(["set", "presencePenalty", "-1"]);
		expect(args.action).toBe("set");
		expect(args.key).toBe("presencePenalty");
		expect(args.value).toBe("-1");
	});

	it("survives in every shape a number takes", async () => {
		for (const value of ["-1", "-0.5", "-.25", "-2e3", "-1e-3", "-0"]) {
			const { args } = await parse(["set", "topP", value]);
			expect(args.value, `${value} must arrive unchanged`).toBe(value);
		}
	});

	it("keeps several negatives in order", async () => {
		const { args } = await parse(["set", "-1", "-2"]);
		expect(args.key).toBe("-1");
		expect(args.value).toBe("-2");
	});
});

describe("a negative number as a flag value", () => {
	it("arrives intact when space-separated", async () => {
		const { flags } = await parse(["set", "--temperature", "-1"]);
		expect(flags.temperature).toBe("-1");
	});

	it("arrives intact when joined with =", async () => {
		const { flags } = await parse(["set", "--temperature=-0.5"]);
		expect(flags.temperature).toBe("-0.5");
	});

	it("parses as an integer flag, sign included", async () => {
		const { flags } = await parse(["set", "--limit", "-5"]);
		expect(flags.limit).toBe(-5);
	});
});

describe("what masking must not change", () => {
	/** The point of strict parsing: a stray flag fails closed rather than being
	 * silently dropped. Masking must not become a hole for that. */
	it("still rejects an unknown flag", async () => {
		await expect(parse(["set", "--nope"])).rejects.toThrow("Unknown flag: --nope");
	});

	it("still rejects a short flag that is not a number", async () => {
		await expect(parse(["set", "-x"])).rejects.toThrow("Unknown flag: -x");
	});

	it("leaves a bare dash alone", async () => {
		const { args } = await parse(["set", "key", "-"]);
		expect(args.value).toBe("-");
	});

	/** After `--` everything is already literal, so the mask must not touch it —
	 * a doubly-handled token would come back with the sentinel visible. */
	it("passes a negative number after -- through unchanged", async () => {
		const { args } = await parse(["set", "key", "--", "-1"]);
		expect(args.value).toBe("-1");
	});

	/** The sentinel is an implementation detail and must never surface. It is
	 * NUL-delimited precisely because a process argument cannot contain a NUL. */
	it("carries no sentinel into any parsed value", async () => {
		const { args, flags } = await parse(["set", "-1", "--temperature", "-2"]);
		const seen = [...Object.values(args), ...Object.values(flags)].filter(
			(value): value is string => typeof value === "string",
		);
		expect(seen.length).toBeGreaterThan(0);
		for (const value of seen) {
			expect(value).not.toContain("\x00");
			expect(value).not.toContain("neg:");
		}
	});
});
