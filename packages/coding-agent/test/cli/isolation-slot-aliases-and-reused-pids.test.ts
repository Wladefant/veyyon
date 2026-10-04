/**
 * WHY: two lifecycle bugs let one process destroy another's live isolation slot.
 *
 * 1. The lifecycle lock was named by `path.resolve`, so a second spelling of the
 *    same directory (a Windows case variant, a junction, a symlinked parent)
 *    took a different lock and both processes ran the "exclusive" section.
 * 2. A claim marker named only a PID, so a slot abandoned by a crashed setup
 *    stayed "live" for as long as any unrelated process held that PID.
 *
 * Contention is proved with a real second process holding the lock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as natives from "@veyyon/natives";
import * as utils from "@veyyon/utils";
import { clearWorktrees } from "../../src/cli/worktree-cli";
import {
	canonicalIsolationPath,
	getIsolationLifecycleLockPath,
	ISOLATION_CLAIM_FILE,
	ISOLATION_OWNER_FILE,
	tryWithIsolationLifecycleLock,
} from "../../src/task/isolation-ownership";
import { ensureIsolation, getRepoRoot, getTaskIsolationSegment } from "../../src/task/worktree";
import { useTrackedTempDirs } from "../helpers/tracked-temp-dir";

const makeTempDir = useTrackedTempDirs("isolation-alias-pid-");
const isWindows = process.platform === "win32";

let root: string;
let workspaces: string;
let stdout: string;
let previousExitCode: typeof process.exitCode;
const children: child_process.ChildProcess[] = [];

beforeEach(async () => {
	root = await fs.realpath(makeTempDir());
	workspaces = path.join(root, "workspaces");
	stdout = "";
	previousExitCode = process.exitCode;
	process.exitCode = 0;
	await fs.mkdir(workspaces);
	vi.spyOn(utils, "getWorktreesDir").mockReturnValue(workspaces);
	vi.spyOn(console, "log").mockImplementation(line => {
		stdout = String(line);
	});
});

afterEach(() => {
	vi.restoreAllMocks();
	process.exitCode = previousExitCode ?? 0;
	for (const child of children.splice(0)) child.kill();
});

function spawnIdleProcess(): child_process.ChildProcess {
	const child = child_process.spawn(process.execPath, ["-e", "setTimeout(() => {}, 120000)"], { stdio: "ignore" });
	children.push(child);
	return child;
}

/** Start a second process that holds the lifecycle lock for `slot` until its stdin closes. */
async function holdLockInChild(slot: string): Promise<child_process.ChildProcess> {
	const script = path.join(root, "hold-lock.ts");
	await fs.writeFile(
		script,
		`
import * as utils from ${JSON.stringify(import.meta.resolve("@veyyon/utils"))};
import { withIsolationLifecycleLock } from ${JSON.stringify(path.resolve(__dirname, "../../src/task/isolation-ownership.ts"))};
utils.setWorktreesDir(process.env.TEST_WORKSPACES_DIR!);
await withIsolationLifecycleLock(process.env.TEST_SLOT!, async () => {
	console.log("HELD");
	await new Promise<void>(resolve => {
		process.stdin.on("end", resolve);
		process.stdin.resume();
	});
});
`,
		"utf8",
	);
	const child = child_process.spawn(process.execPath, [script], {
		env: { ...process.env, TEST_WORKSPACES_DIR: workspaces, TEST_SLOT: slot },
		stdio: ["pipe", "pipe", "inherit"],
	});
	children.push(child);
	await new Promise<void>((resolve, reject) => {
		let seen = "";
		child.stdout!.on("data", chunk => {
			seen += String(chunk);
			if (seen.includes("HELD")) resolve();
		});
		child.once("exit", code => reject(new Error(`lock holder exited early (${code})`)));
	});
	return child;
}

async function release(child: child_process.ChildProcess): Promise<void> {
	const exited = new Promise<void>(resolve => child.once("exit", () => resolve()));
	child.stdin!.end();
	await exited;
}

/** Hash the way the lock did before aliases were canonicalized. */
function legacyLockName(baseDir: string): string {
	const resolved = path.resolve(baseDir);
	return `${path.basename(resolved)}-${crypto.createHash("sha256").update(resolved).digest("hex").slice(0, 16)}`;
}

async function expectAliasContends(slot: string, alias: string): Promise<void> {
	// Negative control: the old namer gives the two spellings different locks, so
	// this test fails if canonicalization is taken out of the lock path.
	expect(legacyLockName(alias)).not.toBe(legacyLockName(slot));
	expect(await getIsolationLifecycleLockPath(alias)).toBe(await getIsolationLifecycleLockPath(slot));

	const holder = await holdLockInChild(slot);
	let entered = false;
	const contended = await tryWithIsolationLifecycleLock(alias, async () => {
		entered = true;
	});
	expect(contended.acquired).toBe(false);
	expect(entered).toBe(false);

	await release(holder);
	const afterRelease = await tryWithIsolationLifecycleLock(alias, async () => "free");
	expect(afterRelease).toMatchObject({ acquired: true, value: "free" });
}

describe("isolation lifecycle lock namespace", () => {
	it.skipIf(isWindows)("a symlinked parent directory shares the slot's lock across processes", async () => {
		const realParent = path.join(root, "real");
		await fs.mkdir(realParent);
		const linkParent = path.join(root, "link");
		await fs.symlink(realParent, linkParent, "dir");
		await expectAliasContends(path.join(realParent, "slot"), path.join(linkParent, "slot"));
	});

	it.skipIf(!isWindows)("a Windows case variant of the slot shares its lock across processes", async () => {
		const slot = path.join(root, "Mixed-Case-Parent", "slot");
		await fs.mkdir(path.dirname(slot));
		const variant = path.join(root.toUpperCase(), "MIXED-case-PARENT", "SLOT");
		await expectAliasContends(slot, variant);
	});

	it.skipIf(!isWindows)("a junction to the parent shares the slot's lock across processes", async () => {
		const realParent = path.join(root, "real");
		await fs.mkdir(realParent);
		const junction = path.join(root, "junction");
		await fs.symlink(realParent, junction, "junction");
		await expectAliasContends(path.join(realParent, "slot"), path.join(junction, "slot"));
	});

	it("a slot that does not exist yet canonicalizes through its deepest existing ancestor", async () => {
		const canonical = await canonicalIsolationPath(path.join(root, "missing", "deeper", "slot"));
		const expected = path.join(root, "missing", "deeper", "slot");
		expect(canonical).toBe(isWindows ? expected.toLowerCase() : expected);
	});

	it("distinct slots keep distinct locks", async () => {
		const holder = await holdLockInChild(path.join(workspaces, "slot-a"));
		const other = await tryWithIsolationLifecycleLock(path.join(workspaces, "slot-b"), async () => "free");
		expect(other).toMatchObject({ acquired: true, value: "free" });
		await release(holder);
	});
});

describe("claim marker process incarnation", () => {
	async function prepare(id: string) {
		const repo = path.join(root, "repo");
		await fs.mkdir(repo, { recursive: true });
		child_process.execFileSync("git", ["init", "-q", repo]);
		const segment = getTaskIsolationSegment(await getRepoRoot(repo), id);
		const slot = path.join(workspaces, segment);
		return { repo, slot };
	}

	async function writeSlot(slot: string, claim: unknown, owner: unknown): Promise<void> {
		await fs.mkdir(slot, { recursive: true });
		await fs.writeFile(path.join(slot, ISOLATION_CLAIM_FILE), JSON.stringify(claim));
		await fs.writeFile(path.join(slot, ISOLATION_OWNER_FILE), JSON.stringify(owner));
	}

	function ownerOf(pid: number, startIdentity: string | null) {
		return { pid, startIdentity, token: "token-1", createdAt: new Date().toISOString() };
	}

	function stubBackend(): void {
		vi.spyOn(natives, "isoResolve").mockReturnValue({
			kind: natives.IsoBackendKind.Rcopy,
			candidates: [natives.IsoBackendKind.Rcopy],
			fellBack: false,
			reason: undefined,
		});
		vi.spyOn(natives, "isoStart").mockImplementation(async (_backend, _source, mergedDir) => {
			await fs.mkdir(mergedDir, { recursive: true });
		});
	}

	/** A live process that is NOT the one that made the claim: same PID, different incarnation. */
	function reusedPid(): { pid: number; staleIdentity: string } {
		const child = spawnIdleProcess();
		const pid = child.pid!;
		const actual = utils.getProcessStartIdentity(pid);
		expect(actual).not.toBeNull();
		expect(utils.isProcessAlive(pid)).toBe(true);
		return { pid, staleIdentity: `${actual}-previous-incarnation` };
	}

	const claimFormats = [
		{
			name: "claim records the incarnation",
			claim: (pid: number, identity: string) => ({ pid, startIdentity: identity }),
		},
		{
			name: "old-format claim falls back to the owner record's identity",
			claim: (pid: number, _identity: string) => ({ pid }),
		},
	];

	for (const format of claimFormats) {
		describe(format.name, () => {
			it("an ordinary clear reclaims a slot whose PID now belongs to an unrelated process", async () => {
				const { slot } = await prepare("reused-ordinary");
				const { pid, staleIdentity } = reusedPid();
				await writeSlot(slot, format.claim(pid, staleIdentity), ownerOf(pid, staleIdentity));

				await clearWorktrees({ all: false, dryRun: false, json: true });
				expect(JSON.parse(stdout)).toMatchObject({ removed: 1, failed: 0 });
				await expect(fs.stat(slot)).rejects.toMatchObject({ code: "ENOENT" });
			});

			it("a --all clear reclaims it too", async () => {
				const { slot } = await prepare("reused-all");
				const { pid, staleIdentity } = reusedPid();
				await writeSlot(slot, format.claim(pid, staleIdentity), ownerOf(pid, staleIdentity));

				await clearWorktrees({ all: true, dryRun: false, json: true });
				expect(JSON.parse(stdout)).toMatchObject({ removed: 1, failed: 0 });
				await expect(fs.stat(slot)).rejects.toMatchObject({ code: "ENOENT" });
			});

			it("a same-id allocation reclaims it and takes the slot", async () => {
				const { repo, slot } = await prepare("reused-allocate");
				const { pid, staleIdentity } = reusedPid();
				await writeSlot(slot, format.claim(pid, staleIdentity), ownerOf(pid, staleIdentity));
				stubBackend();

				const handle = await ensureIsolation(repo, "reused-allocate");
				expect(handle.mergedDir).toBe(path.join(slot, "m"));
				const owner = JSON.parse(await fs.readFile(path.join(slot, ISOLATION_OWNER_FILE), "utf8"));
				expect(owner.pid).toBe(process.pid);
			});
		});
	}

	describe("control: the owner is the matching live process", () => {
		async function liveSlot(id: string) {
			const { repo, slot } = await prepare(id);
			const child = spawnIdleProcess();
			const pid = child.pid!;
			const identity = utils.getProcessStartIdentity(pid);
			expect(identity).not.toBeNull();
			await writeSlot(slot, { pid, startIdentity: identity }, ownerOf(pid, identity));
			return { repo, slot };
		}

		it("an ordinary clear keeps the slot", async () => {
			const { slot } = await liveSlot("live-ordinary");
			await clearWorktrees({ all: false, dryRun: false, json: true });
			expect(await fs.readdir(slot)).toContain(ISOLATION_CLAIM_FILE);
			expect(stdout).not.toContain('"removed": 1');
		});

		it("a --all clear refuses to remove it", async () => {
			const { slot } = await liveSlot("live-all");
			await clearWorktrees({ all: true, dryRun: false, json: true });
			expect(JSON.parse(stdout)).toMatchObject({ removed: 0, failed: 1 });
			expect(await fs.readdir(slot)).toContain(ISOLATION_CLAIM_FILE);
		});

		it("a same-id allocation refuses replacement", async () => {
			const { repo, slot } = await liveSlot("live-allocate");
			stubBackend();
			await expect(ensureIsolation(repo, "live-allocate")).rejects.toThrow("refusing replacement");
			expect(await fs.readdir(slot)).toContain(ISOLATION_CLAIM_FILE);
		});
	});
});
