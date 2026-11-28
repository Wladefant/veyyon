import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { saveOutputArtifact } from "@veyyon/coding-agent/tools/core/output-artifact";
import type { ToolSession } from "@veyyon/coding-agent/tools/index";
import { makeToolSession } from "../helpers/tool-session";

/**
 * saveOutputArtifact is the single owner of the "allocate an artifact slot, then write
 * the full tool output to it" spill path. Its contract is that it returns the artifact
 * id on success and undefined (never throws) on any failure, because the caller already
 * holds a bounded inline result and only loses the full-output recovery footer. This
 * suite locks each undefined path so a future refactor cannot start throwing (which
 * would crash a tool whose visible output was already fine): no artifact store, a null
 * allocation, a missing id, and a write that fails. On success it asserts the exact
 * bytes reach disk and the returned id matches the allocation.
 */

let dir: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "output-artifact-"));
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

const session = (allocateOutputArtifact?: unknown): ToolSession =>
	makeToolSession({ allocateOutputArtifact: allocateOutputArtifact as ToolSession["allocateOutputArtifact"] });

describe("saveOutputArtifact success", () => {
	it("writes the full output to the allocated path and returns its id", async () => {
		const target = path.join(dir, "out.txt");
		const s = session(async (toolType: string) => ({ path: target, id: `id-${toolType}` }));
		expect(await saveOutputArtifact(s, "bash", "hello world")).toBe("id-bash");
		expect(fs.readFileSync(target, "utf8")).toBe("hello world");
	});
});

describe("saveOutputArtifact returns undefined without throwing", () => {
	it("when the session has no artifact store", async () => {
		expect(await saveOutputArtifact(session(undefined), "bash", "x")).toBeUndefined();
	});

	it("when allocation returns null", async () => {
		expect(
			await saveOutputArtifact(
				session(async () => null),
				"bash",
				"x",
			),
		).toBeUndefined();
	});

	it("when the allocation is missing an id", async () => {
		const target = path.join(dir, "out.txt");
		expect(
			await saveOutputArtifact(
				session(async () => ({ path: target })),
				"bash",
				"x",
			),
		).toBeUndefined();
	});

	it("when the write fails (unwritable path)", async () => {
		// A regular file where the directory should be: the write fails for every user, root included.
		// A missing directory is not a portable failure, because root creates it.
		const blocker = path.join(dir, "blocker");
		fs.writeFileSync(blocker, "");
		const s = session(async () => ({ path: path.join(blocker, "out.txt"), id: "z" }));
		expect(await saveOutputArtifact(s, "bash", "x")).toBeUndefined();
	});

	it("when allocation itself throws", async () => {
		const s = session(async () => {
			throw new Error("boom");
		});
		expect(await saveOutputArtifact(s, "bash", "x")).toBeUndefined();
	});
});
