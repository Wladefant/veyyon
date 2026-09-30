#!/usr/bin/env bun
/**
 * Upstream sync: the daily job that keeps this fork in step with both of its upstreams.
 *
 * - oh-my-pi (`omp`): no shared history, so every new commit is a candidate. The commits after a
 *   recorded watermark are classified by `upstream-status` (cited SHA or content match); the ones
 *   the fork lacks get a first-pass verdict from `upstream-port-policy.json`, are appended to the
 *   living backlog, and are summarised in one digest comment. Nothing is ported here.
 * - santhreal/veyyon (`upstream`): shares history, so when `main` is behind it gets a real merge
 *   commit of `upstream/main`, pushed as `sync/santhreal-<tip>` with a pull request. Never merged here.
 *
 * The backlog and the watermark live on the `upstream-sync-data` branch (`omp-backlog.tsv`,
 * `state.json`), seeded from the #107 baseline. A run reads that branch, and a live run pushes one
 * fast-forward commit to it, so two machines or a rerun converge instead of duplicating: a commit
 * already in the backlog, or at or before the watermark, is never added or posted twice.
 *
 * Dry-run is the default and writes nothing remote. `--live` posts, pushes and opens the PR.
 * It never pushes to an upstream remote and never merges.
 *
 * Needs the remotes `origin`, `upstream` (santhreal) and `omp` (oh-my-pi).
 *
 * Usage: bun run upstream:sync [--live] [--issue 107]
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	divergedMatches,
	isDocumentationOnly,
	loadPolicy,
	type PortPolicy,
	portCandidateKind,
	titleType,
} from "./upstream-radar";
import type { OmpClass } from "./upstream-status";

const execFileAsync = promisify(execFile);
const REPO = "Wladefant/veyyon";
const DATA_BRANCH = "upstream-sync-data";
const BASELINE = "docs/internal/upstream-sync/omp-gap-backlog-2026-09-30.tsv";
/** Most rows a digest lists per section; the rest are in the backlog. */
const DIGEST_ROWS = 25;
const AS_IS_MAX_ADDED = 80;
const CARRIED: readonly OmpClass[] = ["cited-santhreal", "content-santhreal", "cited-fork", "content-fork", "noise"];

export interface State {
	ompWatermark: string;
	updated: string;
}

export interface Facts {
	sha: string;
	date: string;
	subject: string;
	files: string[];
	added: number;
}

export interface Row {
	facts: Facts;
	area: string;
	verdict: "take as-is" | "take with rework" | "leave out";
	highRisk: boolean;
	reason: string;
}

/** Commits from `listed` (oldest first) that the backlog or an earlier run has not recorded. */
export function newCommits(listed: readonly Facts[], seen: ReadonlySet<string>): Facts[] {
	return listed.filter(c => !seen.has(c.sha.slice(0, 12)));
}

/** The `upstream_sha12` column of a backlog TSV. */
export function backlogShas(tsv: string): Set<string> {
	return new Set(
		tsv
			.split("\n")
			.slice(1)
			.map(line => line.split("\t")[0])
			.filter(Boolean),
	);
}

const RISK_SUBJECT =
	/\b(auth|oauth|credential|secret|api[- ]?key|permission|approval|sandbox|redact|billing|deadlock|race|concurren|mutex)/i;
const RISK_PATH = /(auth|oauth|credential|secret|permission|approval|sandbox)/i;

export function areaOf(files: readonly string[]): string {
	const votes = new Map<string, number>();
	for (const f of files) {
		const parts = f.split("/");
		const area = parts[0] === "packages" ? (parts[1] ?? "packages") : parts[0];
		votes.set(area, (votes.get(area) ?? 0) + 1);
	}
	return [...votes].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "";
}

/**
 * A mechanical first pass, never a decision: it says what the policy and the fork's file layout
 * allow. `take as-is` needs a fix whose files all exist in the fork, off every diverged surface,
 * under the size cap; anything the policy does not name is left out, anything doubtful is rework.
 */
export function firstPass(facts: Facts, policy: PortPolicy, forkPaths: ReadonlySet<string>): Row {
	const { subject, files, added } = facts;
	const kind = portCandidateKind(subject, policy);
	const diverged = divergedMatches(files, policy)
		.filter(s => s.blocksCleanFeatures !== false)
		.map(s => s.name);
	const absent = files.filter(f => !forkPaths.has(f));
	const row = (verdict: Row["verdict"], reason: string): Row => ({
		facts,
		area: areaOf(files),
		verdict,
		highRisk: RISK_SUBJECT.test(subject) || files.some(f => RISK_PATH.test(f)),
		reason,
	});
	if (kind === null) {
		return row(
			"leave out",
			`type ${titleType(subject) ?? "none"} is not a fix, perf or feat in upstream-port-policy.json`,
		);
	}
	if (isDocumentationOnly(files, policy)) return row("leave out", "documentation only");
	if (kind === "clean-feature") {
		return diverged.length
			? row("leave out", `feature on diverged surface (${diverged.join(", ")}); decide by hand`)
			: row("take with rework", "feature off every diverged surface; product fit unchecked");
	}
	const why = [
		diverged.length > 0 && `touches ${diverged.join(", ")}`,
		absent.length > 0 && `${absent.length} path(s) absent in the fork, e.g. ${absent[0]}`,
		added > AS_IS_MAX_ADDED && `${added} added lines`,
	].filter(Boolean);
	return why.length
		? row("take with rework", why.join("; "))
		: row("take as-is", `same paths in the fork, ${added} added lines`);
}

const cell = (text: string) => text.replace(/[\t\r\n]+/g, " ");

export function rowToTsv(r: Row): string {
	const f = r.facts;
	return [
		f.sha.slice(0, 12),
		f.date,
		f.subject,
		r.area,
		r.verdict,
		"",
		r.highRisk ? "yes" : "",
		"",
		"",
		"low",
		r.reason,
	]
		.map(cell)
		.join("\t");
}

export interface SyncPlan {
	tip: string;
	behind: number;
	ahead: number;
	tree: string;
	conflicts: string[];
}

export interface SyncExisting {
	openPr: string | null;
	branchExists: boolean;
}

/** Open a sync PR only when the merge is clean and no sync PR is open or was already made for this tip. */
export function shouldOpenSync(plan: SyncPlan | null, existing: SyncExisting): boolean {
	return plan !== null && plan.conflicts.length === 0 && existing.openPr === null && !existing.branchExists;
}

export interface Digest {
	from: string;
	to: string;
	total: number;
	carried: number;
	rows: Row[];
	dataUrl: string;
	sync: string;
}

const omp = (sha: string) => `https://github.com/can1357/oh-my-pi/commit/${sha}`;
export const digestMarker = (to: string) => `<!-- upstream-sync-digest: ${to.slice(0, 12)} -->`;

export function renderDigest(d: Digest): string {
	const by = (v: Row["verdict"]) => d.rows.filter(r => r.verdict === v).length;
	const table = (rows: Row[]) =>
		[
			"| commit | subject | area | verdict |",
			"|---|---|---|---|",
			...rows
				.slice(0, DIGEST_ROWS)
				.map(
					r =>
						`| [\`${r.facts.sha.slice(0, 12)}\`](${omp(r.facts.sha)}) | ${cell(r.facts.subject)} | ${r.area} | ${r.verdict} |`,
				),
			...(rows.length > DIGEST_ROWS ? [`| | and ${rows.length - DIGEST_ROWS} more in the backlog | | |`] : []),
		].join("\n");
	const risky = d.rows.filter(r => r.highRisk);
	const asIs = d.rows.filter(r => r.verdict === "take as-is" && !r.highRisk);
	return [
		digestMarker(d.to),
		`## Upstream watch: oh-my-pi \`${d.from.slice(0, 12)}..${d.to.slice(0, 12)}\``,
		"",
		`${d.total} new non-merge commits: ${d.carried} already carried or noise (not listed), ${d.rows.length} appended to the [backlog](${d.dataUrl}): ${by("take as-is")} take as-is, ${by("take with rework")} take with rework, ${by("leave out")} leave out, ${risky.length} high risk.`,
		"",
		"Verdicts are a mechanical first pass (confidence `low`); each port still needs its own triage and negative control.",
		...(risky.length
			? ["", "### High risk (auth, approval, sandbox, secret, concurrency): review before any port", table(risky)]
			: []),
		...(asIs.length ? ["", "### Take as-is candidates", table(asIs)] : []),
		"",
		`santhreal/veyyon: ${d.sync}`,
	].join("\n");
}

export interface Ports {
	readData(): Promise<{ tsv: string; state: State | null; parent: string | null }>;
	facts(since: string | null, sinceDate: string): Promise<Facts[]>;
	tip(): Promise<string>;
	classes(): Promise<Map<string, OmpClass>>;
	forkPaths(): Promise<Set<string>>;
	digestExists(marker: string): Promise<boolean>;
	postDigest(body: string): Promise<string>;
	writeData(tsv: string, state: State, parent: string | null): Promise<string>;
	syncPlan(): Promise<SyncPlan | null>;
	syncExisting(plan: SyncPlan): Promise<SyncExisting>;
	openSync(plan: SyncPlan): Promise<string>;
}

export interface Outcome {
	rows: number;
	digest: string | null;
	sync: string;
	watermark: string;
}

/**
 * One run. The watermark moves only after the digest is posted (or found already posted) and the
 * data commit is pushed, so a failure anywhere leaves it where it was and the next run retries.
 */
export async function run(ports: Ports, policy: PortPolicy, live: boolean): Promise<Outcome> {
	const data = await ports.readData();
	const tip = await ports.tip();
	const seen = backlogShas(data.tsv);
	const baselineDate =
		[...data.tsv.split("\n").slice(1)]
			.map(l => l.split("\t")[1] ?? "")
			.sort()
			.pop() ?? "";
	const listed = await ports.facts(data.state?.ompWatermark ?? null, baselineDate);
	const fresh = newCommits(listed, seen);
	const classes = await ports.classes();
	const forkPaths = await ports.forkPaths();
	const missing = fresh.filter(c => {
		const cls = classes.get(c.sha);
		return cls === undefined || !CARRIED.includes(cls);
	});
	const rows = missing.map(c => firstPass(c, policy, forkPaths));
	const from = data.state?.ompWatermark ?? fresh[0]?.sha ?? tip;

	const plan = await ports.syncPlan();
	let sync = "in step with origin/main";
	if (plan) {
		const existing = await ports.syncExisting(plan);
		sync = plan.conflicts.length
			? `${plan.behind} commits behind; the merge conflicts in ${plan.conflicts.slice(0, 8).join(", ")}${plan.conflicts.length > 8 ? ", ..." : ""}: resolve by hand`
			: existing.openPr
				? `${plan.behind} commits behind; sync PR already open: ${existing.openPr}`
				: existing.branchExists
					? `${plan.behind} commits behind; a sync branch for this tip already exists`
					: `${plan.behind} commits behind; ${live ? "opening a sync PR" : "a sync PR would open"}`;
		if (live && shouldOpenSync(plan, existing)) {
			const url = await ports.openSync(plan);
			sync = `${plan.behind} commits behind; sync PR opened: ${url}`;
		}
	}

	const out: Outcome = { rows: rows.length, digest: null, sync, watermark: data.state?.ompWatermark ?? "" };
	if (!live) return { ...out, watermark: tip };
	const body = renderDigest({
		from,
		to: tip,
		total: fresh.length,
		carried: fresh.length - rows.length,
		rows,
		dataUrl: `https://github.com/${REPO}/blob/${DATA_BRANCH}/omp-backlog.tsv`,
		sync,
	});
	if (rows.length > 0 && !(await ports.digestExists(digestMarker(tip)))) out.digest = await ports.postDigest(body);
	const tsv = rows.length ? `${data.tsv.replace(/\n*$/, "\n")}${rows.map(r => rowToTsv(r)).join("\n")}\n` : data.tsv;
	await ports.writeData(tsv, { ompWatermark: tip, updated: new Date().toISOString() }, data.parent);
	return { ...out, watermark: tip };
}

async function exec(cmd: string, args: string[], input?: string, okCodes: number[] = [0]) {
	const child = execFileAsync(cmd, args, { maxBuffer: 1 << 30, timeout: 25 * 60_000, encoding: "utf8" });
	if (input !== undefined) child.child.stdin?.end(input);
	try {
		return { stdout: (await child).stdout, code: 0 };
	} catch (err) {
		const e = err as { code?: number; stdout?: string; stderr?: string };
		if (typeof e.code === "number" && okCodes.includes(e.code)) return { stdout: e.stdout ?? "", code: e.code };
		throw new Error(`${cmd} ${args.join(" ")} failed: ${e.stderr ?? String(err)}`);
	}
}
const git = async (args: string[], input?: string) => (await exec("git", args, input)).stdout.trimEnd();
const gh = async (args: string[]) => (await exec("gh", ["--repo", REPO, ...args])).stdout.trim();

function parseFacts(log: string): Facts[] {
	return log
		.split("\x01")
		.filter(Boolean)
		.map(block => {
			const [head, ...stat] = block.trim().split("\n");
			const [sha, date, ...subject] = head.split("\t");
			const files = stat.filter(Boolean).map(l => l.split("\t"));
			return {
				sha,
				date,
				subject: subject.join("\t"),
				files: files.map(f => f[2]),
				added: files.reduce((n, f) => n + (Number(f[0]) || 0), 0),
			};
		});
}

function gitPorts(issue: string): Ports {
	const show = async (path: string) => {
		try {
			return await git(["show", path]);
		} catch {
			return null;
		}
	};
	return {
		async readData() {
			await git(["fetch", "origin", `+refs/heads/${DATA_BRANCH}:refs/remotes/origin/${DATA_BRANCH}`]).catch(
				() => "",
			);
			const ref = `origin/${DATA_BRANCH}`;
			const state = await show(`${ref}:state.json`);
			const tsv = (await show(`${ref}:omp-backlog.tsv`)) ?? (await git(["show", `origin/main:${BASELINE}`]));
			const parent = state ? await git(["rev-parse", ref]) : null;
			return { tsv, state: state ? (JSON.parse(state) as State) : null, parent };
		},
		async facts(since, sinceDate) {
			if (
				since &&
				(await exec("git", ["merge-base", "--is-ancestor", since, "omp/main"], undefined, [0, 1])).code === 1
			) {
				throw new Error(`watermark ${since} is not an ancestor of omp/main; correct state.json by hand`);
			}
			const range = since ? [`${since}..omp/main`] : [`--since=${sinceDate}`, "omp/main"];
			const log = await git([
				"log",
				"--no-merges",
				"--reverse",
				"--numstat",
				"--no-renames",
				"--format=%x01%H%x09%cs%x09%s",
				...range,
			]);
			return parseFacts(log);
		},
		tip: () => git(["rev-parse", "omp/main"]),
		async classes() {
			const { stdout } = await exec(process.execPath, ["scripts/upstream-status.ts", "--format", "json"]);
			const status = JSON.parse(stdout) as { omp: { commits: Array<{ sha: string; cls: OmpClass }> } };
			return new Map(status.omp.commits.map(c => [c.sha, c.cls]));
		},
		async forkPaths() {
			return new Set((await git(["ls-tree", "-r", "--name-only", "origin/main"])).split("\n"));
		},
		async digestExists(marker) {
			const bodies = await gh([
				"api",
				`issues/${issue}/comments`,
				"--paginate",
				"--jq",
				'.[].body | select(contains("digest:"))',
			]);
			return bodies.includes(marker);
		},
		postDigest: body => gh(["issue", "comment", issue, "--body", body]),
		async writeData(tsv, state, parent) {
			const blob = async (text: string) => git(["hash-object", "-w", "--stdin"], text);
			const tree = await git(
				["mktree"],
				`100644 blob ${await blob(tsv)}\tomp-backlog.tsv\n100644 blob ${await blob(`${JSON.stringify(state, null, "\t")}\n`)}\tstate.json\n`,
			);
			const message = `data: oh-my-pi watermark ${state.ompWatermark.slice(0, 12)}\n\nRefs #107`;
			const commit = await git(["commit-tree", tree, ...(parent ? ["-p", parent] : []), "-m", message]);
			await git(["push", "origin", `${commit}:refs/heads/${DATA_BRANCH}`]);
			return commit;
		},
		async syncPlan() {
			const [behind, ahead] = (await git(["rev-list", "--left-right", "--count", "upstream/main...origin/main"]))
				.split(/\s+/)
				.map(Number);
			if (behind === 0) return null;
			const merged = await exec(
				"git",
				["merge-tree", "--write-tree", "--name-only", "origin/main", "upstream/main"],
				undefined,
				[0, 1],
			);
			const [tree, ...rest] = merged.stdout.split("\n");
			const blank = rest.indexOf("");
			const conflicts = merged.code === 1 ? rest.slice(0, blank < 0 ? rest.length : blank).filter(Boolean) : [];
			return { tip: await git(["rev-parse", "upstream/main"]), behind, ahead, tree, conflicts };
		},
		async syncExisting(plan) {
			const open = JSON.parse(
				await gh(["pr", "list", "--state", "open", "--limit", "100", "--json", "url,headRefName"]),
			) as Array<{ url: string; headRefName: string }>;
			const branch = await git(["ls-remote", "origin", `refs/heads/sync/santhreal-${plan.tip.slice(0, 12)}`]);
			return {
				openPr: open.find(p => p.headRefName.startsWith("sync/santhreal-"))?.url ?? null,
				branchExists: branch !== "",
			};
		},
		async openSync(plan) {
			const tip = plan.tip.slice(0, 12);
			const merge = await git([
				"commit-tree",
				plan.tree,
				"-p",
				"origin/main",
				"-p",
				"upstream/main",
				"-m",
				`Merge santhreal/veyyon ${tip} into main\n\nRefs #107`,
			]);
			await git(["push", "origin", `${merge}:refs/heads/sync/santhreal-${tip}`]);
			const changed = (await git(["diff", "--name-only", "origin/main", merge])).split("\n");
			const heavy = changed.filter(f =>
				/(^|\/)(bun\.lock|Cargo\.lock|package\.json|Dockerfile[^/]*)$|^\.github\/workflows\//.test(f),
			);
			const body = [
				`Merges santhreal/veyyon \`${tip}\` (${plan.behind} commits behind, ${plan.ahead} ahead) into \`main\` as a real merge commit, made by \`scripts/upstream-sync.ts\`. Sync only: no review; merge it with \`--merge\` on green local checks.`,
				heavy.length
					? `\nTouches dependency or workflow files, so build and boot it before merging: ${heavy.join(", ")}`
					: "",
				"\nRefs #107",
			].join("\n");
			return gh([
				"pr",
				"create",
				"--base",
				"main",
				"--head",
				`sync/santhreal-${tip}`,
				"--title",
				`chore(sync): merge santhreal/veyyon ${tip} (${plan.behind} commits behind)`,
				"--body",
				body,
			]);
		},
	};
}

async function main(argv: string[]): Promise<void> {
	const live = argv.includes("--live");
	const i = argv.indexOf("--issue");
	const issue = i >= 0 ? argv[i + 1] : "107";
	await git(["fetch", "origin", "+refs/heads/main:refs/remotes/origin/main"]);
	await git(["fetch", "upstream", "+refs/heads/main:refs/remotes/upstream/main"]);
	await git(["fetch", "omp", "--no-tags", "+refs/heads/main:refs/remotes/omp/main"]);
	const out = await run(gitPorts(issue), loadPolicy(), live);
	process.stdout.write(`${live ? "LIVE" : "DRY-RUN"} ${JSON.stringify(out, null, "\t")}\n`);
}

if (import.meta.main) {
	await main(process.argv.slice(2));
}
