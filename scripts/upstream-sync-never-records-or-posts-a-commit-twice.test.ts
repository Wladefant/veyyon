/**
 * WHY: `upstream-sync.ts` runs daily, unattended, on a schedule that can fire twice, die halfway, or
 * run from two machines. Three defects would cost real work: a commit appended to the backlog or
 * posted to issue #107 twice buries the triage in duplicates; a watermark that advances before the
 * digest is out silently drops commits forever; and a sync PR opened over a conflict, or a second one
 * beside an open one, hands the operator a broken or redundant merge. The suite drives `run` against
 * an in-memory remote (data branch, issue comments) and replays it, so each of those is an observed
 * outcome and not a reading of the code.
 *
 * Gap: the git and gh adapters (`gitPorts`) are not run here; they are checked by `bun run
 * upstream:sync` in dry-run against the real remotes.
 */
import { describe, expect, it } from "bun:test";
import { loadPolicy } from "./upstream-radar";
import type { OmpClass } from "./upstream-status";
import {
	backlogShas,
	digestMarker,
	type Facts,
	firstPass,
	newCommits,
	type Ports,
	run,
	type State,
	type SyncPlan,
	shouldOpenSync,
} from "./upstream-sync";

const HEADER =
	"upstream_sha12\tdate\tsubject\tarea\tverdict\timpact\thigh_risk_review\tcluster\tdepends_on\tconfidence\treason";
const sha = (n: number) => `${n.toString(16).padStart(2, "0")}`.repeat(20);
const policy = loadPolicy();

function commit(n: number, subject: string, files = ["packages/coding-agent/src/a.ts"]): Facts {
	return { sha: sha(n), date: "2026-10-01", subject, files, added: 10 };
}

/** An in-memory remote: the data branch, the issue comments, the sync PR state. */
function remote(listed: Facts[], classes: Record<string, OmpClass> = {}, plan: SyncPlan | null = null) {
	const store = {
		tsv: `${HEADER}\n`,
		state: null as State | null,
		comments: [] as string[],
		writes: 0,
		syncsOpened: 0,
		failPost: false,
		tip: listed.at(-1)?.sha ?? sha(0),
	};
	const ports: Ports = {
		readData: async () => ({ tsv: store.tsv, state: store.state, parent: store.state ? "parent" : null }),
		// A real `git log since..tip` returns only what follows the watermark.
		facts: async since => {
			if (!since) return listed;
			const at = listed.findIndex(c => c.sha === since);
			return at < 0 ? listed : listed.slice(at + 1);
		},
		tip: async () => store.tip,
		classes: async () => new Map(listed.map(c => [c.sha, classes[c.sha] ?? "missing"])),
		forkPaths: async () => new Set(["packages/coding-agent/src/a.ts"]),
		digestExists: async marker => store.comments.some(c => c.includes(marker)),
		postDigest: async body => {
			if (store.failPost) throw new Error("gh is down");
			store.comments.push(body);
			return `comment-${store.comments.length}`;
		},
		writeData: async (tsv, state) => {
			store.writes++;
			store.tsv = tsv;
			store.state = state;
			return "data-commit";
		},
		syncPlan: async () => plan,
		syncExisting: async () => ({ openPr: null, branchExists: store.syncsOpened > 0 }),
		openSync: async () => {
			store.syncsOpened++;
			return "sync-pr-url";
		},
	};
	return { store, ports };
}

describe("a commit is recorded and posted once", () => {
	const listed = [commit(1, "fix(tui): a"), commit(2, "feat(agent): b"), commit(3, "chore: c")];

	it("appends each new commit to the backlog and posts one digest, then a rerun does neither", async () => {
		const { store, ports } = remote(listed);
		const first = await run(ports, policy, true);
		expect(first.rows).toBe(3);
		expect(backlogShas(store.tsv)).toEqual(new Set(listed.map(c => c.sha.slice(0, 12))));
		expect(store.comments).toHaveLength(1);

		const again = await run(ports, policy, true);
		expect(again.rows).toBe(0);
		expect(again.digest).toBeNull();
		expect(store.comments).toHaveLength(1);
		expect(store.tsv.split("\n").filter(Boolean)).toHaveLength(4);
	});

	it("skips a commit already in the backlog even when the watermark is absent", async () => {
		const { store, ports } = remote(listed);
		store.tsv = `${HEADER}\n${listed[0].sha.slice(0, 12)}\t2026-10-01\tfix(tui): a\ttui\ttake as-is\t\t\t\t\tlow\tx\n`;
		const out = await run(ports, policy, true);
		expect(out.rows).toBe(2);
		expect(store.tsv.match(new RegExp(listed[0].sha.slice(0, 12), "g"))).toHaveLength(1);
	});

	it("does not list a commit the fork or santhreal already carries", async () => {
		const { store, ports } = remote(listed, { [sha(1)]: "cited-santhreal", [sha(3)]: "noise" });
		const out = await run(ports, policy, true);
		expect(out.rows).toBe(1);
		expect(backlogShas(store.tsv)).toEqual(new Set([sha(2).slice(0, 12)]));
	});

	it("posts nothing and writes nothing in a dry run", async () => {
		const { store, ports } = remote(listed);
		const out = await run(ports, policy, false);
		expect(out.rows).toBe(3);
		expect(store.comments).toHaveLength(0);
		expect(store.writes).toBe(0);
		expect(store.state).toBeNull();
	});
});

describe("the watermark advances only after the digest is out", () => {
	it("keeps the watermark and the backlog when posting fails, then recovers on the next run", async () => {
		const listed = [commit(1, "fix: a"), commit(2, "fix: b")];
		const { store, ports } = remote(listed);
		store.failPost = true;
		await expect(run(ports, policy, true)).rejects.toThrow("gh is down");
		expect(store.state).toBeNull();
		expect(backlogShas(store.tsv).size).toBe(0);

		store.failPost = false;
		const out = await run(ports, policy, true);
		expect(out.rows).toBe(2);
		expect(store.state?.ompWatermark).toBe(sha(2));
		expect(store.comments).toHaveLength(1);
	});

	it("does not repost a digest that already exists for the tip when only the data push failed", async () => {
		const listed = [commit(1, "fix: a")];
		const { store, ports } = remote(listed);
		store.comments.push(`${digestMarker(sha(1))}\nearlier run`);
		await run(ports, policy, true);
		expect(store.comments).toHaveLength(1);
		expect(backlogShas(store.tsv)).toEqual(new Set([sha(1).slice(0, 12)]));
	});

	it("picks up only commits after the watermark on the next day", async () => {
		const day1 = [commit(1, "fix: a")];
		const { store, ports } = remote(day1);
		await run(ports, policy, true);
		const next = remote([...day1, commit(2, "fix: b")]);
		next.store.tsv = store.tsv;
		next.store.state = store.state;
		const out = await run(next.ports, policy, true);
		expect(out.rows).toBe(1);
		expect(backlogShas(next.store.tsv)).toEqual(new Set([sha(1).slice(0, 12), sha(2).slice(0, 12)]));
	});
});

describe("the santhreal sync PR", () => {
	const clean: SyncPlan = { tip: sha(9), behind: 4, ahead: 2, tree: "tree", conflicts: [] };

	it("opens for a clean merge, and a rerun opens no second one", async () => {
		const { store, ports } = remote([], {}, clean);
		store.tip = sha(0);
		await run(ports, policy, true);
		await run(ports, policy, true);
		expect(store.syncsOpened).toBe(1);
	});

	it("never opens over a conflict, in a dry run, or beside an open sync PR", async () => {
		expect(shouldOpenSync({ ...clean, conflicts: ["a.ts"] }, { openPr: null, branchExists: false })).toBe(false);
		expect(shouldOpenSync(clean, { openPr: "url", branchExists: false })).toBe(false);
		expect(shouldOpenSync(clean, { openPr: null, branchExists: true })).toBe(false);
		expect(shouldOpenSync(null, { openPr: null, branchExists: false })).toBe(false);
		expect(shouldOpenSync(clean, { openPr: null, branchExists: false })).toBe(true);

		const { store, ports } = remote([], {}, clean);
		await run(ports, policy, false);
		expect(store.syncsOpened).toBe(0);
	});
});

describe("the first-pass verdict", () => {
	const fork = new Set(["packages/coding-agent/src/a.ts", "packages/coding-agent/src/b.ts"]);

	it("takes a small fix on paths the fork has as-is", () => {
		expect(firstPass(commit(1, "fix(tui): clamp"), policy, fork).verdict).toBe("take as-is");
	});

	it("reworks a fix that touches a path the fork lacks", () => {
		const row = firstPass(commit(1, "fix(tui): clamp", ["packages/coding-agent/src/gone.ts"]), policy, fork);
		expect(row.verdict).toBe("take with rework");
		expect(row.reason).toContain("absent in the fork");
	});

	it("reworks a fix over the added-line cap", () => {
		expect(firstPass({ ...commit(1, "fix: big"), added: 500 }, policy, fork).verdict).toBe("take with rework");
	});

	it("leaves out a chore and a docs-only change, and flags an auth fix as high risk", () => {
		expect(firstPass(commit(1, "chore: bump"), policy, fork).verdict).toBe("leave out");
		expect(firstPass(commit(1, "docs: words", ["README.md"]), policy, fork).verdict).toBe("leave out");
		expect(firstPass(commit(1, "fix(auth): refresh token race"), policy, fork).highRisk).toBe(true);
	});
});

describe("newCommits", () => {
	it("drops every commit whose 12-character prefix is already seen", () => {
		const a = commit(1, "fix: a");
		expect(newCommits([a, commit(2, "fix: b")], new Set([a.sha.slice(0, 12)])).map(c => c.sha)).toEqual([sha(2)]);
	});
});
