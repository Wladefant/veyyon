import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@veyyon/utils";
import { ArtifactManager, writeArtifactAtomically } from "../src/session/artifacts";

/**
 * WHY THIS EXISTS. An artifact is resolved by SCANNING the artifacts directory for
 * `${id}.`, and nothing compares the file against what was meant to be written. Artifact
 * bytes used to go straight to that path with `Bun.write`, so a write that stopped short
 * left a truncated file that resolved as a complete result, and a rewrite of an existing
 * path destroyed the previous bytes before it knew whether the new ones would land. The
 * class this closes is "an artifact path never holds a partial payload", not one
 * reported short write: every writer routes through {@link writeArtifactAtomically}, and
 * these cases pin the publication contract rather than the byte counts of one input.
 *
 * GAP THIS DOES NOT COVER. The Windows replace-existing recovery lives in
 * `@veyyon/utils/atomic-write` and is gated on `process.platform === "win32"`, which this
 * suite cannot reach from the Linux sandbox, so a rename that reports `EPERM`/`EEXIST`
 * on Windows is not exercised here — only the staging contract around it. A partial
 * payload that the filesystem reports as the FULL byte count (silent corruption, not a
 * short write) is also undetectable by construction.
 */

describe("artifact publication is whole-or-nothing", () => {
	const dirs: string[] = [];

	async function freshDir(): Promise<string> {
		const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-artifact-whole-"));
		dirs.push(dir);
		return dir;
	}

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const dir of dirs.splice(0)) await removeWithRetries(dir);
	});

	/** Model a short write faithfully: partial bytes land, and the count reports short. */
	function shortWrite(keep: number): void {
		const realWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(async (target, content) => {
			await realWrite(target as string, String(content).slice(0, keep));
			return keep;
		});
	}

	it("publishes nothing when the staged write falls short", async () => {
		const dir = await freshDir();
		const manager = new ArtifactManager(dir);
		const { id, path: artifactPath } = await manager.allocatePath("task");
		shortWrite(3);

		await expect(writeArtifactAtomically(artifactPath, "full report body")).rejects.toThrow(
			"Artifact write incomplete: wrote 3 of 16 bytes",
		);

		// Neither the artifact nor a leftover staging sibling may survive, or the
		// directory scan resolves a truncated payload as a finished result.
		expect(await fs.readdir(dir)).toEqual([]);
		expect(await manager.getPath(id)).toBeNull();
		expect(await manager.exists(id)).toBe(false);
	});

	it("keeps the previous bytes when a later write to the same path falls short", async () => {
		const dir = await freshDir();
		const artifactPath = path.join(dir, "0.task.log");
		await writeArtifactAtomically(artifactPath, "original valid report");
		shortWrite(2);

		await expect(writeArtifactAtomically(artifactPath, "replacement report")).rejects.toThrow(
			"Artifact write incomplete",
		);

		expect(await Bun.file(artifactPath).text()).toBe("original valid report");
		// One file: the staging sibling was removed, and the backup a Windows
		// replacement would own is not left behind either.
		expect(await fs.readdir(dir)).toEqual(["0.task.log"]);
	});

	it("resolves the exact bytes a completed save wrote", async () => {
		const dir = await freshDir();
		const manager = new ArtifactManager(dir);
		const body = "line one\nline two\n";

		const id = await manager.save(body, "task");

		expect(await manager.exists(id)).toBe(true);
		const resolved = await manager.getPath(id);
		expect(resolved).not.toBeNull();
		expect(await Bun.file(resolved as string).text()).toBe(body);
		// Exactly the artifact, with no staging sibling left next to it.
		expect(await fs.readdir(dir)).toEqual([path.basename(resolved as string)]);
	});

	it("assigns the next id past whatever the directory already holds", async () => {
		const dir = await freshDir();
		await writeArtifactAtomically(path.join(dir, "7.task.log"), "earlier artifact");
		const manager = new ArtifactManager(dir);

		const id = await manager.save("fresh", "task");

		expect(id).toBe("8");
		expect((await manager.listFiles()).sort()).toEqual(["7.task.log", "8.task.log"]);
	});
});
