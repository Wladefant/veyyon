import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentProtocolHandler } from "@veyyon/coding-agent/internal-urls/agent-protocol";
import { ArtifactProtocolHandler } from "@veyyon/coding-agent/internal-urls/artifact-protocol";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";
import {
	registerArtifactsDir,
	resetRegisteredArtifactDirsForTests,
} from "@veyyon/coding-agent/internal-urls/registry-helpers";

/**
 * WHY: a read of a missing `artifact://N` failed with every artifact id in every registered
 * session directory. Ids are per-session counters that only grow, so a long session printed
 * thousands of ids into one tool result and paid for them in context on every later turn.
 * `agent://` did the same with every agent output name.
 *
 * CLASS: a not-found error that lists the members of a collection which grows with the
 * session. Both handlers that scan the artifacts directories are driven here through the
 * real registry, across the limit boundary (at, one past, far past) and the empty case.
 *
 * NOT CAUGHT: the PDF image member error shares `formatBoundedList` but needs an extracted
 * PDF to reach, so it is not driven here; a caller that builds its own unbounded join
 * instead of calling the helper is not caught either.
 */
describe("a missing id lists a bounded sample of what exists", () => {
	let root: string;
	let dir: string;
	const unregisters: Array<() => void> = [];
	const artifacts = new ArtifactProtocolHandler();
	const agents = new AgentProtocolHandler();

	async function seedArtifacts(count: number): Promise<void> {
		for (let i = 0; i < count; i++) await Bun.write(path.join(dir, `${i}.out.md`), `artifact ${i}`);
	}

	async function missingArtifactError(): Promise<string> {
		try {
			await artifacts.resolve(parseInternalUrl("artifact://30064"), { pathOnly: true });
		} catch (err) {
			return (err as Error).message;
		}
		throw new Error("artifact://30064 resolved");
	}

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "bounded-not-found-"));
		dir = path.join(root, "session");
		await fs.mkdir(dir, { recursive: true });
		resetRegisteredArtifactDirsForTests();
		unregisters.push(registerArtifactsDir(dir));
	});

	afterEach(async () => {
		for (const off of unregisters.splice(0)) off();
		resetRegisteredArtifactDirsForTests();
		await fs.rm(root, { recursive: true, force: true });
	});

	it("names the twenty newest artifacts and counts the rest", async () => {
		await seedArtifacts(100);

		const newest = Array.from({ length: 20 }, (_, i) => String(99 - i)).join(", ");
		expect(await missingArtifactError()).toBe(`Artifact 30064 not found. Available: ${newest}, … 80 more`);
	});

	it("lists every artifact when there are exactly twenty", async () => {
		await seedArtifacts(20);

		const message = await missingArtifactError();
		expect(message).toEndWith("19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1, 0");
		expect(message).not.toContain("more");
	});

	it("cuts at twenty when there is one more than that", async () => {
		await seedArtifacts(21);

		const message = await missingArtifactError();
		expect(message).toEndWith("2, 1, … 1 more");
		expect(message).not.toContain(" 0,");
	});

	it("says none when the session has no artifacts", async () => {
		expect(await missingArtifactError()).toBe("Artifact 30064 not found. Available: none");
	});

	it("bounds the agent output names the same way", async () => {
		for (let i = 0; i < 50; i++) await Bun.write(path.join(dir, `Worker${i}.md`), `output ${i}`);

		const error = await agents.resolve(parseInternalUrl("agent://Missing")).then(
			() => null,
			(err: Error) => err.message,
		);

		expect(error).not.toBeNull();
		const listed = (error ?? "").split("\nAvailable: ")[1] ?? "";
		expect(listed).toEndWith(", … 30 more");
		expect(listed.split(", ").filter(name => name.startsWith("Worker"))).toHaveLength(20);
	});
});
