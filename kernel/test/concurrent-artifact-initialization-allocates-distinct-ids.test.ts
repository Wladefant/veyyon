import { afterEach, describe, expect, it } from "bun:test";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeSyncWithRetries } from "@veyyon/utils";
import { ArtifactManager } from "../src/session/artifacts";

/**
 * WHY THIS SUITE EXISTS:
 * ArtifactManager.#ensureDir checked #initialized then awaited #scanExistingIds()
 * before setting #initialized = true. Concurrent first-use save/allocatePath calls
 * both observed #initialized = false, both scanned the directory, and both re-seeded
 * #nextId from maxId + 1. Both calls then received the exact same id, silently
 * overwriting files or creating ambiguous artifact:// resolution.
 *
 * WHAT THIS SUITE CLOSES:
 * Racing first-use callers on fresh instances (empty or pre-populated artifact dirs)
 * must receive monotonically distinct artifact IDs and keep distinct file contents.
 *
 * GAPS LEFT OPEN:
 * Cross-process concurrency is bounded by directory locking at session level, not
 * internal in-process synchronization across multiple ArtifactManager instances
 * pointing at the same directory.
 */
describe("concurrent artifact initialization allocates distinct ids", () => {
	const dirs: string[] = [];

	function freshDir(): string {
		const dir = path.join(os.tmpdir(), `veyyon-artifacts-${crypto.randomUUID()}`, "session");
		dirs.push(path.dirname(dir));
		return dir;
	}

	afterEach(() => {
		for (const dir of dirs.splice(0)) {
			removeSyncWithRetries(dir);
		}
	});

	// First-use init (dir scan -> #nextId seed) must run exactly once. Two callers
	// racing a fresh manager both yield inside #scanExistingIds before either
	// marks init done; if the second re-seeds #nextId after the first consumed an
	// id, both allocate the same numeric id and the second write clobbers the
	// first. Same toolType => file overwrite; the first id resolves to B's bytes.
	it("hands concurrent same-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("CONTENT-A", "bash"), mgr.save("CONTENT-B", "bash")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(pathA).not.toBeNull();
		expect(pathB).not.toBeNull();
		expect(await fs.readFile(pathA as string, "utf8")).toBe("CONTENT-A");
		expect(await fs.readFile(pathB as string, "utf8")).toBe("CONTENT-B");
	});

	// Different toolTypes turn a duplicate id into two coexisting files
	// (`{id}.bash.log` + `{id}.async.log`); getPath's startsWith(`${id}.`) then
	// resolves ambiguously in unspecified readdir order. Distinct ids keep each
	// artifact:// pointing at the content its caller wrote.
	it("hands concurrent different-toolType savers distinct ids that each resolve to their own content", async () => {
		const mgr = new ArtifactManager(freshDir());
		const [idA, idB] = await Promise.all([mgr.save("BASH-BYTES", "bash"), mgr.save("ASYNC-BYTES", "async")]);

		expect(idA).not.toBe(idB);

		const pathA = await mgr.getPath(idA);
		const pathB = await mgr.getPath(idB);
		expect(await fs.readFile(pathA as string, "utf8")).toBe("BASH-BYTES");
		expect(await fs.readFile(pathB as string, "utf8")).toBe("ASYNC-BYTES");
	});

	// The race also re-opens on a fresh manager over a directory that already
	// holds artifacts (e.g. after a #artifactManager = null reset): the scan
	// seeds from maxId, and concurrent callers must still get ids past it.
	it("does not reuse ids when racing init over a pre-populated directory", async () => {
		const dir = freshDir();
		const seed = new ArtifactManager(dir);
		await seed.save("OLD", "bash");

		const mgr = new ArtifactManager(dir);
		const [idA, idB] = await Promise.all([mgr.save("NEW-A", "bash"), mgr.save("NEW-B", "bash")]);

		expect(idA).not.toBe(idB);
		expect(await fs.readFile((await mgr.getPath(idA)) as string, "utf8")).toBe("NEW-A");
		expect(await fs.readFile((await mgr.getPath(idB)) as string, "utf8")).toBe("NEW-B");
	});
});
