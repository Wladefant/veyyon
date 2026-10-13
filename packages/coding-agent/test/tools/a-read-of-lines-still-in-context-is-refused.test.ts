/**
 * A read whose every line is unchanged and still in context is refused; any other read delivers.
 *
 * WHY THIS SUITE EXISTS. A model that re-reads a file it can already see pays for the same bytes
 * twice and grows the context it reasons over. The `read` tool refuses such a call with a short
 * result that points back at the earlier output, and the model has no argument that overrides it. A refusal that fires
 * when it should not is worse than none: the model is told to work from output it cannot see, or
 * from bytes that no longer match the file. So the contract has two halves, and both are asserted:
 *
 * - Refused: every row the read would display is displayed, byte for byte under the same header, by
 *   an earlier read result the model still sees (one result or the union of several).
 * - Delivered: the file changed, including a change the 16-bit tag misses (a hash collision, an edit
 *   to trailing whitespace); any requested line was never shown; the earlier result was pruned;
 *   the only earlier "coverage" is itself a refusal; the earlier rows were clipped at a different
 *   column cap; the read is `:raw`, a delimited list, or in a display mode with no
 *   snapshot tag; the session exposes no live messages (the advisor); a same-named file elsewhere.
 *
 * The decision is `refuseReadStillInContext` in `tools/fs/read-in-context.ts`, reached here only
 * through the tool. The suite drives the real `Agent` loop and the real `read` tool against a real directory. Only the
 * model is scripted. `getLiveMessages` reads `agent.state.messages`, which is what the production
 * tool session passes, so a result appended mid-run is visible to the next call in the same run.
 *
 * What it does NOT catch: compaction's summary replacing old reads (the read is simply absent from
 * the messages, which the "never read" rows already cover), and whether a model obeys the refusal.
 */
import { afterEach, describe, expect, it } from "bun:test";
import type { ToolResultMessage } from "@veyyon/ai";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ReadToolDetails } from "@veyyon/coding-agent/tools/fs/read";
import { computeFileHash } from "@veyyon/hashline";
import { createIntegrationWorkspace, type IntegrationWorkspace } from "../helpers/integration-workspace";

/** One scripted read call, with an optional side effect run just before the model emits it. */
interface ReadStep {
	args: Record<string, unknown>;
	before?: (workspace: IntegrationWorkspace) => void;
}

interface DriveOptions {
	files?: Record<string, string>;
	/** Settings the tools read; a step's `before` may change them. */
	settings?: Settings;
	/** Wire `getLiveMessages` to the agent's live messages. Default true. */
	live?: boolean;
}

const NOTES = Array.from({ length: 40 }, (_, i) => `note ${i + 1}`).join("\n");
const OTHER = "other 1\nother 2\n";
const HEADER = /^\[[^\]\n]+#[0-9A-F]{4}\]$/m;

/** `NOTES` with line 3 rewritten until the whole file hashes to the same 16-bit tag as `NOTES`. */
function collidingNotes(): string {
	const tag = computeFileHash(NOTES);
	const lines = NOTES.split("\n");
	for (let k = 0; ; k++) {
		lines[2] = `note 3 variant ${k}`;
		const candidate = lines.join("\n");
		if (computeFileHash(candidate) === tag) return candidate;
	}
}

let workspace: IntegrationWorkspace | undefined;

afterEach(() => {
	workspace?.dispose();
	workspace = undefined;
});

/** Run `steps` as consecutive read calls in one agent run and return every read result in order. */
async function drive(
	steps: readonly ReadStep[],
	options: DriveOptions = {},
): Promise<ToolResultMessage<ReadToolDetails>[]> {
	const settings = options.settings ?? Settings.isolated();
	const script = (function* () {
		for (const step of steps) {
			yield () => {
				if (workspace) step.before?.(workspace);
				return { content: [{ type: "toolCall" as const, name: "read", arguments: step.args }] };
			};
		}
		yield { content: ["done"] };
	})();
	workspace = await createIntegrationWorkspace({
		files: options.files ?? { "notes.txt": NOTES, "other.txt": OTHER },
		tools: ["read", "edit"],
		script,
		toolSession: {
			settings,
			...(options.live === false ? {} : { getLiveMessages: () => workspace?.agent.state.messages ?? [] }),
		},
	});
	await workspace.send("read");
	const results = workspace.agent.state.messages.filter(
		(message): message is ToolResultMessage<ReadToolDetails> =>
			message.role === "toolResult" && message.toolName === "read",
	);
	expect(results).toHaveLength(steps.length);
	return results;
}

function text(result: ToolResultMessage<ReadToolDetails>): string {
	return result.content.map(block => (block.type === "text" ? block.text : "")).join("\n");
}

function header(result: ToolResultMessage<ReadToolDetails>): string {
	const match = text(result).match(HEADER);
	if (!match) throw new Error(`Expected a hashline header in:\n${text(result)}`);
	return match[0];
}

/** `"refused"` or `"delivered"`, after checking the result is consistent with that verdict. */
function verdict(result: ToolResultMessage<ReadToolDetails>): "refused" | "delivered" {
	expect(result.isError).toBe(false);
	if (result.details?.inContextRefusal === true) {
		expect(text(result)).toContain("Read refused:");
		return "refused";
	}
	expect(text(result)).not.toContain("Read refused:");
	return "delivered";
}

/** Mark the `index`th read result pruned, the shape the overflow prune leaves for the provider to drop. */
function prune(index: number): (workspace: IntegrationWorkspace) => void {
	return ws => {
		const reads = ws.agent.state.messages.filter(
			(message): message is ToolResultMessage => message.role === "toolResult" && message.toolName === "read",
		);
		const target = reads[index];
		if (!target) throw new Error(`No read result #${index} to prune`);
		target.prunedAt = Date.now();
	};
}

describe("a read of lines still in context", () => {
	it("refuses an unchanged whole-file re-read with the earlier output's header and a pointer back", async () => {
		const [first, second] = await drive([{ args: { path: "notes.txt" } }, { args: { path: "notes.txt" } }]);
		expect(verdict(first)).toBe("delivered");
		expect(verdict(second)).toBe("refused");
		expect(text(second)).toBe(
			`${header(first)}\nRead refused: \`notes.txt\` is unchanged since an earlier read whose output is still in your context. Work from that output; its line numbers and tag are current.`,
		);
	});

	it.each<[string, ReadStep[], Array<"refused" | "delivered">]>([
		[
			"a range inside an earlier whole-file read",
			[{ args: { path: "notes.txt" } }, { args: { path: "notes.txt:3-5" } }],
			["delivered", "refused"],
		],
		[
			"a whole file covered by the union of two earlier ranges",
			[{ args: { path: "notes.txt:1-20" } }, { args: { path: "notes.txt:21-40" } }, { args: { path: "notes.txt" } }],
			["delivered", "delivered", "refused"],
		],
		[
			"a whole file after only a range of it",
			[{ args: { path: "notes.txt:3-5" } }, { args: { path: "notes.txt" } }],
			["delivered", "delivered"],
		],
		[
			"a range overlapping an earlier one only in part",
			[{ args: { path: "notes.txt:1-5" } }, { args: { path: "notes.txt:5-20" } }],
			["delivered", "delivered"],
		],
		[
			"a file that changed since the earlier read",
			[
				{ args: { path: "notes.txt" } },
				{ args: { path: "notes.txt" }, before: ws => ws.seed("notes.txt", `${NOTES}\nnote 41`) },
			],
			["delivered", "delivered"],
		],
		[
			"a stray force: true, which no longer overrides the refusal",
			[{ args: { path: "notes.txt" } }, { args: { path: "notes.txt", force: true } }],
			["delivered", "refused"],
		],
		[
			"a :raw re-read",
			[{ args: { path: "notes.txt" } }, { args: { path: "notes.txt:raw" } }],
			["delivered", "delivered"],
		],
		[
			"an earlier result that was pruned",
			[{ args: { path: "notes.txt" } }, { args: { path: "notes.txt" }, before: prune(0) }],
			["delivered", "delivered"],
		],
		[
			"a pruned read whose only remaining trace is a refusal",
			[
				{ args: { path: "notes.txt" } },
				{ args: { path: "notes.txt" } },
				{ args: { path: "notes.txt" }, before: prune(0) },
			],
			["delivered", "refused", "delivered"],
		],
		[
			"a file shown by an earlier delimited list",
			[{ args: { path: "notes.txt;other.txt" } }, { args: { path: "notes.txt" } }],
			["delivered", "refused"],
		],
		[
			"a delimited list naming a file already in context",
			[{ args: { path: "notes.txt" } }, { args: { path: "notes.txt;other.txt" } }],
			["delivered", "delivered"],
		],
		[
			"a different file",
			[{ args: { path: "notes.txt" } }, { args: { path: "other.txt" } }],
			["delivered", "delivered"],
		],
	])("%s", async (_name, steps, expected) => {
		const results = await drive(steps);
		expect(results.map(verdict)).toEqual(expected);
	});

	it("delivers the file a changed read describes, under a new tag", async () => {
		const [first, second] = await drive([
			{ args: { path: "notes.txt" } },
			{ args: { path: "notes.txt" }, before: ws => ws.seed("notes.txt", `${NOTES}\nnote 41`) },
		]);
		expect(header(second)).not.toBe(header(first));
		expect(text(second)).toContain("note 41");
	});

	describe("a change the snapshot tag does not see", () => {
		it("delivers a file whose new content collides with the old tag", async () => {
			const colliding = collidingNotes();
			const [first, second] = await drive([
				{ args: { path: "notes.txt" } },
				{ args: { path: "notes.txt" }, before: ws => ws.seed("notes.txt", colliding) },
			]);
			expect(header(second)).toBe(header(first));
			expect(verdict(second)).toBe("delivered");
			expect(text(second)).toContain(colliding.split("\n")[2]!);
		});

		it("delivers a file whose only change is trailing whitespace the tag normalizes away", async () => {
			const [first, second] = await drive([
				{ args: { path: "notes.txt" } },
				{
					args: { path: "notes.txt" },
					before: ws => ws.seed("notes.txt", NOTES.replace("note 3\n", "note 3   \n")),
				},
			]);
			expect(header(second)).toBe(header(first));
			expect(verdict(second)).toBe("delivered");
			expect(text(second)).toContain("3:note 3   \n");
		});

		it.each<[string, string, "refused" | "delivered"]>([
			["refuses a range whose displayed rows the collision left byte-identical", "notes.txt:10-12", "refused"],
			["delivers a range whose padded context shows the line the collision changed", "notes.txt:1-2", "delivered"],
		])("%s", async (_name, range, expected) => {
			const results = await drive([
				{ args: { path: "notes.txt" } },
				{ args: { path: range }, before: ws => ws.seed("notes.txt", collidingNotes()) },
			]);
			expect(results.map(verdict)).toEqual(["delivered", expected]);
		});
	});

	it("delivers a delimited list in full when one of its files is already in context", async () => {
		const [, list] = await drive([{ args: { path: "notes.txt" } }, { args: { path: "notes.txt;other.txt" } }]);
		expect(text(list)).toContain("note 40");
		expect(text(list)).toContain("other 2");
	});

	it("does not treat an identical file of the same name in another directory as already shown", async () => {
		const results = await drive([{ args: { path: "a/notes.txt" } }, { args: { path: "b/notes.txt" } }], {
			files: { "a/notes.txt": NOTES, "b/notes.txt": NOTES },
		});
		expect(results.map(verdict)).toEqual(["delivered", "delivered"]);
	});

	describe("rows clipped at the column cap", () => {
		const files = { "wide.txt": `short 1\n${"x".repeat(2_000)}\nshort 3\n` };

		it("are refused at the cap they were clipped at", async () => {
			const results = await drive([{ args: { path: "wide.txt" } }, { args: { path: "wide.txt" } }], { files });
			expect(results[0]?.details?.meta?.limits?.columnTruncated).toBeDefined();
			expect(results.map(verdict)).toEqual(["delivered", "refused"]);
		});

		it("are delivered once the cap changed, since the row would now show different bytes", async () => {
			const settings = Settings.isolated();
			const results = await drive(
				[
					{ args: { path: "wide.txt" } },
					{
						args: { path: "wide.txt" },
						before: () => {
							settings.set("tools.outputMaxColumns", 4_096);
						},
					},
				],
				{ files, settings },
			);
			expect(results.map(verdict)).toEqual(["delivered", "delivered"]);
			expect(text(results[1]!)).toContain("x".repeat(2_000));
		});
	});

	it("never refuses in a display mode that carries no snapshot tag", async () => {
		const results = await drive([{ args: { path: "notes.txt" } }, { args: { path: "notes.txt" } }], {
			settings: Settings.isolated({ "edit.mode": "replace", readLineNumbers: true }),
		});
		expect(text(results[0]!)).toContain("1|note 1");
		expect(results.map(verdict)).toEqual(["delivered", "delivered"]);
	});

	it("never refuses for a session that exposes no live messages", async () => {
		const results = await drive([{ args: { path: "notes.txt" } }, { args: { path: "notes.txt" } }], { live: false });
		expect(results.map(verdict)).toEqual(["delivered", "delivered"]);
	});
});
