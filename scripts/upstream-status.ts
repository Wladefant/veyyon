#!/usr/bin/env bun
/**
 * Upstream status: how far this fork sits from both of its upstreams, and which upstream commits
 * it still lacks, each one classified as already carried or missing.
 *
 * The lineage is oh-my-pi (`can1357/oh-my-pi`) -> santhreal/veyyon -> this fork. santhreal's
 * history starts at one imported snapshot of oh-my-pi, so no git ancestry joins the two: git's
 * ahead/behind counts only work against santhreal, and for oh-my-pi every commit after the
 * snapshot is a candidate that this script has to match by other means. Two of them:
 *
 * - citation: a commit message on the santhreal side, a commit message on the fork side, or a
 *   merged fork pull request body names the oh-my-pi commit (a 7+ hex prefix of its SHA) or its
 *   upstream pull request (`oh-my-pi#N`, `can1357/oh-my-pi/pull/N`, `[upstream #N]`,
 *   `port(upstream#N)`).
 * - content: at least 70% of the commit's significant added lines, normalized for the rename,
 *   were added by the santhreal or fork tree since the snapshot. Commits with fewer than three
 *   significant lines are too small to match this way and are reported as `missing-small`.
 *
 * santhreal wins ties: a commit santhreal carries arrives with the next santhreal merge, so it is
 * not a port candidate here.
 *
 * A missing commit that removes a line a carried commit added is a follow-up: upstream corrected
 * something this fork already ported, and the port still ships the defect. Those are listed first
 * because they are the cheapest correctness wins. The procedure that consumes this report is in
 * `UPSTREAM.md`.
 *
 * Needs the remotes `upstream` (santhreal/veyyon) and `omp` (oh-my-pi) fetched. Fork pull request
 * bodies are read with `gh`; pass `--no-github` to skip them.
 *
 * Usage: bun run upstream:status
 *        bun scripts/upstream-status.ts [--fork <ref>] [--santhreal <ref>] [--omp <ref>]
 *          [--format text|tsv|json] [--all] [--no-github]
 *
 * `text` (the default) prints the santhreal gap, the per-class counts and the missing follow-ups;
 * `--all` adds every class's commit list. `--format tsv` prints every oh-my-pi commit after the
 * snapshot with its class and follow-up links; `json` prints the same data structured.
 */
import { execFile, spawn } from "node:child_process";
import { join } from "node:path";
import * as readline from "node:readline";
import { promisify } from "node:util";

const REPO_ROOT = join(import.meta.dirname, "..");

const execFileAsync = promisify(execFile);

/** santhreal's root commit: the imported oh-my-pi snapshot, renamed to Veyyon. */
export const SANTHREAL_SNAPSHOT = "6dbf3350c2e8a6e4cfe3aa13c311e6d09a30f33a";
/**
 * The oh-my-pi commit whose tree that snapshot imported: v16.5.2 (`7d02778c60f4`) plus two
 * commits. Found by counting identical blobs between the snapshot and every oh-my-pi commit of
 * 2026-07-14 to 2026-07-17; this one shares the most.
 */
export const OMP_SNAPSHOT = "79faf94f265100a5c05234a16ce67cd621f6e5e8";

/** Paths whose diffs say nothing about whether a change was carried: generated or per-release. */
const NOISE_PATHSPEC = [
	":(exclude)**/models.json",
	":(exclude)**/CHANGELOG.md",
	":(exclude)CHANGELOG.md",
	":(exclude)*.lock",
	":(exclude)**/*.lock",
	":(exclude)**/*.generated.*",
	":(exclude)**/*_pb.ts",
	":(exclude)**/*.snap",
];

const CONTENT_THRESHOLD = 0.7;
const MIN_SIGNIFICANT_LINES = 3;
/** oh-my-pi pull requests were already past this number at the snapshot; santhreal's never reach it. */
const MIN_OMP_PR = 3000;

export type Carrier = "santhreal" | "fork";

export type OmpClass =
	| "cited-santhreal"
	| "content-santhreal"
	| "cited-fork"
	| "content-fork"
	| "noise"
	| "missing"
	| "missing-small";

export interface OmpCommit {
	sha: string;
	date: string;
	subject: string;
	pr: number | null;
	significant: number;
	/** Fraction of significant added lines present in each carrier's tree, when measurable. */
	present: Record<Carrier, number>;
	cls: OmpClass;
	/**
	 * For a commit neither carrier has: the carried oh-my-pi commits whose added lines this one
	 * removes or rewrites, i.e. upstream's own follow-up fix to something already ported.
	 */
	followUpOf: string[];
}

/**
 * Fold a diff line to the form both sides of the rename share: whitespace collapsed, package scopes
 * and brand words replaced. Applied to both sides, so a line survives the rename but still has to
 * match everywhere else.
 */
export function normalizeLine(line: string): string {
	return line
		.trim()
		.replace(/\s+/g, " ")
		.replace(/@(?:oh-my-pi|veyyon)\/(?:pi-)?/g, "@pkg/")
		.replace(/\b(?:PI|OMP|VEYYON)_/g, "BRAND_")
		.replace(/\b(?:oh-my-pi|omp|veyyon|pi)\b/gi, "brand");
}

/** A line distinctive enough that finding it on the other side means something. */
export function isSignificant(normalized: string): boolean {
	if (normalized.length < 20) return false;
	if (!/[A-Za-z]{3}/.test(normalized)) return false;
	return !/^(?:import\b|export \* from|export \{|\} from\b|from ["'])/.test(normalized);
}

/** cyrb53: a 53-bit string hash, so a multi-million-line set costs numbers rather than strings. */
export function lineHash(text: string): number {
	let h1 = 0xdeadbeef;
	let h2 = 0x41c6ce57;
	for (let i = 0; i < text.length; i++) {
		const ch = text.charCodeAt(i);
		h1 = Math.imul(h1 ^ ch, 2654435761);
		h2 = Math.imul(h2 ^ ch, 1597334677);
	}
	h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
	h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
	return 4294967296 * (2097151 & h2) + (h1 >>> 0);
}

/** Resolves a hex token to the one oh-my-pi commit it abbreviates, or null when unknown or ambiguous. */
export class ShaIndex {
	#byPrefix = new Map<string, string[]>();

	constructor(shas: Iterable<string>) {
		for (const sha of shas) {
			const key = sha.slice(0, 7);
			const bucket = this.#byPrefix.get(key);
			if (bucket) bucket.push(sha);
			else this.#byPrefix.set(key, [sha]);
		}
	}

	resolve(token: string): string | null {
		const lower = token.toLowerCase();
		const hits = (this.#byPrefix.get(lower.slice(0, 7)) ?? []).filter(sha => sha.startsWith(lower));
		return hits.length === 1 ? hits[0] : null;
	}
}

export interface Citations {
	shas: Set<string>;
	prs: Set<number>;
}

/** Every oh-my-pi commit and pull request a piece of text names. */
export function collectCitations(text: string, index: ShaIndex, into: Citations): void {
	for (const match of text.matchAll(/\b[0-9a-f]{7,40}\b/gi)) {
		const sha = index.resolve(match[0]);
		if (sha) into.shas.add(sha);
	}
	const prPatterns = [
		/oh-my-pi(?:\/pull\/|\/issues\/|#)(\d+)/gi,
		/\[upstream #(\d+)\]/gi,
		/\bupstream ?#(\d+)/gi,
		/upstream-pr: (\d+)/gi,
	];
	for (const pattern of prPatterns) {
		for (const match of text.matchAll(pattern)) {
			const pr = Number(match[1]);
			if (pr >= MIN_OMP_PR) into.prs.add(pr);
		}
	}
}

export interface Evidence {
	citations: Record<Carrier, Citations>;
	present: Record<Carrier, number>;
	significant: number;
	/** True when every path the commit touched is generated or per-release noise. */
	noiseOnly: boolean;
}

/** One commit's class. santhreal outranks the fork, and a citation outranks a content match. */
export function classify(sha: string, pr: number | null, evidence: Evidence): OmpClass {
	const cited = (carrier: Carrier) =>
		evidence.citations[carrier].shas.has(sha) || (pr !== null && evidence.citations[carrier].prs.has(pr));
	const content = (carrier: Carrier) =>
		evidence.significant >= MIN_SIGNIFICANT_LINES && evidence.present[carrier] >= CONTENT_THRESHOLD;
	if (cited("santhreal")) return "cited-santhreal";
	if (content("santhreal")) return "content-santhreal";
	if (cited("fork")) return "cited-fork";
	if (content("fork")) return "content-fork";
	if (evidence.noiseOnly) return "noise";
	return evidence.significant < MIN_SIGNIFICANT_LINES ? "missing-small" : "missing";
}

/** A line added by more commits than this is boilerplate, not a trace of one change. */
const MAX_LINE_AUTHORS = 2;

/**
 * Fill `followUpOf` on every commit neither carrier has with the carried commits it amends: an
 * earlier carried commit added a line this one removes. Porting a fix without its follow-up ships
 * the defect upstream already corrected, so these are the first candidates to port.
 *
 * `commits` is oldest first; `lines` holds each commit's significant added and removed line hashes.
 */
export function linkFollowUps(
	commits: Array<Pick<OmpCommit, "sha" | "cls" | "followUpOf">>,
	lines: ReadonlyMap<string, { added: readonly number[]; removed: readonly number[] }>,
): void {
	const authors = new Map<number, number>();
	for (const { added } of lines.values()) {
		for (const hash of new Set(added)) authors.set(hash, (authors.get(hash) ?? 0) + 1);
	}
	const carriedBy = new Map<number, number[]>();
	commits.forEach((commit, position) => {
		if (!commit.cls.startsWith("cited-") && !commit.cls.startsWith("content-")) return;
		for (const hash of new Set(lines.get(commit.sha)?.added ?? [])) {
			if ((authors.get(hash) ?? 0) > MAX_LINE_AUTHORS) continue;
			const bucket = carriedBy.get(hash);
			if (bucket) bucket.push(position);
			else carriedBy.set(hash, [position]);
		}
	});
	commits.forEach((commit, position) => {
		if (!commit.cls.startsWith("missing")) return;
		const amended = new Set<string>();
		for (const hash of lines.get(commit.sha)?.removed ?? []) {
			for (const earlier of carriedBy.get(hash) ?? []) {
				if (earlier < position) amended.add(commits[earlier].sha);
			}
		}
		commit.followUpOf = [...amended];
	});
}

async function git(args: string[]): Promise<string> {
	const { stdout } = await execFileAsync("git", args, { cwd: REPO_ROOT, maxBuffer: 512 * 1024 * 1024 });
	return stdout;
}

/** Stream a git command's stdout line by line, failing on a non-zero exit. */
async function gitLines(args: string[], onLine: (line: string) => void): Promise<void> {
	const child = spawn("git", args, { cwd: REPO_ROOT, stdio: ["ignore", "pipe", "pipe"] });
	let stderr = "";
	child.stderr.on("data", chunk => {
		stderr += chunk;
	});
	const exited = new Promise<number | null>(resolve => child.on("close", resolve));
	for await (const line of readline.createInterface({ input: child.stdout, crlfDelay: Infinity })) onLine(line);
	const code = await exited;
	if (code !== 0) throw new Error(`git ${args.slice(0, 3).join(" ")} … exited ${code}: ${stderr.trim()}`);
}

export interface PatchHandlers {
	added: (line: string) => void;
	removed?: (line: string) => void;
	commit?: (sha: string) => void;
}

/**
 * Walk a `-U0` patch stream, calling `added` and `removed` for each changed line and `commit` for
 * each `commit <sha>` header when the stream is a log. Headers are recognized by state, not by
 * prefix, because an added line that itself starts with `++` prints as `+++`: with no context
 * lines, a hunk holds only `+`, `-` and `\` lines, and anything else ends it.
 */
export function patchWalker(handlers: PatchHandlers): (line: string) => void {
	let inHunk = false;
	return line => {
		if (inHunk) {
			if (line.startsWith("+")) {
				handlers.added(line.slice(1));
				return;
			}
			if (line.startsWith("-")) {
				handlers.removed?.(line.slice(1));
				return;
			}
			if (line.startsWith("\\")) return;
			inHunk = false;
		}
		if (line.startsWith("@@ ")) inHunk = true;
		else if (handlers.commit && line.startsWith("commit ")) handlers.commit(line.slice(7, 47));
	};
}

/** The hash of a diff line when it is significant, else null. */
function significantHash(line: string): number | null {
	const normalized = normalizeLine(line);
	return isSignificant(normalized) ? lineHash(normalized) : null;
}

/** Hashes of every significant line a ref added to its tree since the snapshot. */
async function addedSince(ref: string): Promise<Set<number>> {
	const lines = new Set<number>();
	await gitLines(
		[
			"diff",
			"-U0",
			"--no-color",
			"--no-renames",
			"--no-ext-diff",
			SANTHREAL_SNAPSHOT,
			ref,
			"--",
			".",
			...NOISE_PATHSPEC,
		],
		patchWalker({
			added: line => {
				const hash = significantHash(line);
				if (hash !== null) lines.add(hash);
			},
		}),
	);
	return lines;
}

async function forkPullBodies(): Promise<string> {
	const origin = (await git(["remote", "get-url", "origin"])).trim();
	const slug = /github\.com[/:]([^/]+\/[^/.]+)/.exec(origin)?.[1];
	if (!slug) throw new Error(`origin is not a GitHub remote: ${origin}`);
	const { stdout } = await execFileAsync(
		"gh",
		["pr", "list", "--repo", slug, "--state", "merged", "--limit", "5000", "--json", "body", "--jq", ".[].body"],
		{ maxBuffer: 256 * 1024 * 1024 },
	);
	return stdout;
}

/** Map every non-merge oh-my-pi commit to the pull request whose merge brought it onto the first-parent line. */
function assignPullRequests(
	log: Array<{ sha: string; parents: string[]; subject: string }>,
	firstParent: Set<string>,
): Map<string, number> {
	const byId = new Map(log.map(entry => [entry.sha, entry]));
	const prOf = new Map<string, number>();
	for (const entry of log) {
		const squash = /\(#(\d+)\)\s*$/.exec(entry.subject);
		if (squash && entry.parents.length === 1) prOf.set(entry.sha, Number(squash[1]));
	}
	for (const entry of log) {
		if (!firstParent.has(entry.sha) || entry.parents.length < 2) continue;
		const merged = /^Merge (?:PR|pull request) #(\d+)/.exec(entry.subject);
		if (!merged) continue;
		const pr = Number(merged[1]);
		const stack = entry.parents.slice(1);
		while (stack.length > 0) {
			const sha = stack.pop() as string;
			if (firstParent.has(sha) || prOf.has(sha)) continue;
			const commit = byId.get(sha);
			if (!commit) continue;
			prOf.set(sha, pr);
			stack.push(...commit.parents);
		}
	}
	return prOf;
}

async function assertRef(ref: string, fetchHint: string): Promise<string> {
	try {
		return (await git(["rev-parse", "--verify", `${ref}^{commit}`])).trim();
	} catch {
		throw new Error(`${ref} does not resolve. ${fetchHint}`);
	}
}

interface Options {
	fork: string;
	santhreal: string;
	omp: string;
	format: "text" | "tsv" | "json";
	all: boolean;
	github: boolean;
}

function parseArgs(argv: string[]): Options {
	const options: Options = {
		fork: "origin/main",
		santhreal: "upstream/main",
		omp: "omp/main",
		format: "text",
		all: false,
		github: true,
	};
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined) throw new Error(`${arg} needs a value`);
			return next;
		};
		if (arg === "--fork") options.fork = value();
		else if (arg === "--santhreal") options.santhreal = value();
		else if (arg === "--omp") options.omp = value();
		else if (arg === "--format") {
			const format = value();
			if (format !== "text" && format !== "tsv" && format !== "json") throw new Error(`unknown format ${format}`);
			options.format = format;
		} else if (arg === "--all") options.all = true;
		else if (arg === "--no-github") options.github = false;
		else throw new Error(`unknown argument ${arg}`);
	}
	return options;
}

async function main(options: Options): Promise<void> {
	const fork = await assertRef(options.fork, "Fetch origin.");
	const santhreal = await assertRef(
		options.santhreal,
		"Add and fetch santhreal: git remote add upstream https://github.com/santhreal/veyyon.git && git fetch upstream",
	);
	const omp = await assertRef(
		options.omp,
		"Add and fetch oh-my-pi: git remote add omp https://github.com/can1357/oh-my-pi.git && git fetch omp --no-tags",
	);
	await assertRef(OMP_SNAPSHOT, "The oh-my-pi snapshot commit is missing; fetch omp without a shallow depth.");

	// santhreal shares history with the fork, so git answers directly.
	const [aheadBehind, cherry] = await Promise.all([
		git(["rev-list", "--left-right", "--count", `${fork}...${santhreal}`]),
		git(["cherry", fork, santhreal]),
	]);
	const [forkAhead, santhrealAhead] = aheadBehind.trim().split(/\s+/).map(Number);
	const santhrealMissing: string[] = [];
	let santhrealEquivalent = 0;
	for (const line of cherry.split("\n")) {
		if (line.startsWith("+ ")) santhrealMissing.push(line.slice(2));
		else if (line.startsWith("- ")) santhrealEquivalent++;
	}
	const santhrealSubjects = santhrealMissing.length
		? await git(["log", "--no-walk=unsorted", "--format=%H%x09%cs%x09%s", ...santhrealMissing])
		: "";

	// oh-my-pi shares none, so every commit after the snapshot is matched by citation or content.
	const rawLog = await git(["log", "--format=%H%x09%P%x09%cs%x09%s", `${OMP_SNAPSHOT}..${omp}`]);
	const log = rawLog
		.split("\n")
		.filter(Boolean)
		.map(line => {
			const [sha, parents, date, ...subject] = line.split("\t");
			return { sha, parents: parents ? parents.split(" ") : [], date, subject: subject.join("\t") };
		});
	const firstParent = new Set((await git(["rev-list", "--first-parent", `${OMP_SNAPSHOT}..${omp}`])).split("\n"));
	const prOf = assignPullRequests(log, firstParent);
	const index = new ShaIndex(log.map(entry => entry.sha));

	const citations: Record<Carrier, Citations> = {
		santhreal: { shas: new Set(), prs: new Set() },
		fork: { shas: new Set(), prs: new Set() },
	};
	const [santhrealMessages, forkMessages, pullBodies, santhrealLines, forkLines] = await Promise.all([
		git(["log", "--format=%B", `${SANTHREAL_SNAPSHOT}..${santhreal}`]),
		git(["log", "--format=%B", `${santhreal}..${fork}`]),
		options.github ? forkPullBodies() : Promise.resolve(""),
		addedSince(santhreal),
		addedSince(fork),
	]);
	collectCitations(santhrealMessages, index, citations.santhreal);
	collectCitations(forkMessages, index, citations.fork);
	collectCitations(pullBodies, index, citations.fork);

	interface Measured {
		significant: number;
		present: Record<Carrier, number>;
		added: number[];
		removed: number[];
	}
	const measured = new Map<string, Measured>();
	let current: { sha: string; santhreal: number; fork: number; added: number[]; removed: number[] } | null = null;
	const flush = () => {
		if (!current) return;
		const significant = current.added.length;
		measured.set(current.sha, {
			significant,
			present: {
				santhreal: significant ? current.santhreal / significant : 0,
				fork: significant ? current.fork / significant : 0,
			},
			added: current.added,
			removed: current.removed,
		});
	};
	await gitLines(
		[
			"log",
			"-p",
			"-U0",
			"--no-color",
			"--no-renames",
			"--no-merges",
			"--no-ext-diff",
			"--format=commit %H",
			`${OMP_SNAPSHOT}..${omp}`,
			"--",
			".",
			...NOISE_PATHSPEC,
		],
		patchWalker({
			added: line => {
				if (!current) return;
				const hash = significantHash(line);
				if (hash === null) return;
				current.added.push(hash);
				if (santhrealLines.has(hash)) current.santhreal++;
				if (forkLines.has(hash)) current.fork++;
			},
			removed: line => {
				if (!current) return;
				const hash = significantHash(line);
				if (hash !== null) current.removed.push(hash);
			},
			commit: sha => {
				flush();
				current = { sha, santhreal: 0, fork: 0, added: [], removed: [] };
			},
		}),
	);
	flush();

	const commits: OmpCommit[] = [];
	for (const entry of log) {
		if (entry.parents.length > 1) continue;
		const seen = measured.get(entry.sha);
		const pr = prOf.get(entry.sha) ?? null;
		const evidence: Evidence = {
			citations,
			present: seen?.present ?? { santhreal: 0, fork: 0 },
			significant: seen?.significant ?? 0,
			noiseOnly: !seen,
		};
		commits.push({
			sha: entry.sha,
			date: entry.date,
			subject: entry.subject,
			pr,
			significant: evidence.significant,
			present: evidence.present,
			cls: classify(entry.sha, pr, evidence),
			followUpOf: [],
		});
	}
	commits.reverse();
	linkFollowUps(commits, measured);

	const counts = new Map<OmpClass, number>();
	for (const commit of commits) counts.set(commit.cls, (counts.get(commit.cls) ?? 0) + 1);
	const forkSinceSnapshot = Number(
		(await git(["rev-list", "--count", "--no-merges", `${santhreal}..${fork}`])).trim(),
	);

	if (options.format === "json") {
		process.stdout.write(
			`${JSON.stringify(
				{
					santhreal: {
						ref: santhreal,
						forkAhead,
						santhrealAhead,
						missing: santhrealMissing,
						equivalent: santhrealEquivalent,
					},
					omp: { ref: omp, snapshot: OMP_SNAPSHOT, counts: Object.fromEntries(counts), commits },
				},
				null,
				"\t",
			)}\n`,
		);
		return;
	}
	if (options.format === "tsv") {
		process.stdout.write("sha\tdate\tpr\tclass\tsignificant\tsanthreal\tfork\tfollowUpOf\tsubject\n");
		for (const c of commits) {
			process.stdout.write(
				`${c.sha}\t${c.date}\t${c.pr ?? ""}\t${c.cls}\t${c.significant}\t${c.present.santhreal.toFixed(2)}\t${c.present.fork.toFixed(2)}\t${c.followUpOf.map(sha => sha.slice(0, 12)).join(",")}\t${c.subject}\n`,
			);
		}
		return;
	}

	const out: string[] = [];
	out.push(`santhreal/veyyon (${options.santhreal} ${santhreal.slice(0, 12)})`);
	out.push(`  fork ahead ${forkAhead}, behind ${santhrealAhead}`);
	out.push(
		`  non-merge commits the fork lacks: ${santhrealMissing.length} (patch-equivalent already carried: ${santhrealEquivalent})`,
	);
	for (const line of santhrealSubjects.split("\n").filter(Boolean)) {
		const [sha, date, subject] = line.split("\t");
		out.push(`    ${sha.slice(0, 12)} ${date} ${subject}`);
	}
	out.push("");
	out.push(`oh-my-pi (${options.omp} ${omp.slice(0, 12)}, snapshot ${OMP_SNAPSHOT.slice(0, 12)})`);
	out.push(
		`  non-merge oh-my-pi commits past the snapshot: ${commits.length}; fork-only commits past santhreal: ${forkSinceSnapshot}`,
	);
	const order: OmpClass[] = [
		"cited-santhreal",
		"content-santhreal",
		"cited-fork",
		"content-fork",
		"noise",
		"missing",
		"missing-small",
	];
	for (const cls of order) out.push(`  ${cls.padEnd(18)} ${counts.get(cls) ?? 0}`);
	const followUps = commits.filter(commit => commit.followUpOf.length > 0);
	out.push("", `  missing follow-ups to carried commits (${followUps.length}):`);
	for (const c of followUps) {
		const amends = c.followUpOf.map(sha => sha.slice(0, 12)).join(", ");
		out.push(`    ${c.sha.slice(0, 12)} ${c.date} ${c.pr ? `#${c.pr} ` : ""}${c.subject} (amends ${amends})`);
	}
	if (options.all) {
		for (const cls of order) {
			const members = commits.filter(commit => commit.cls === cls);
			if (members.length === 0) continue;
			out.push("", `  ${cls}:`);
			for (const c of members) {
				out.push(`    ${c.sha.slice(0, 12)} ${c.date} ${c.pr ? `#${c.pr} ` : ""}${c.subject}`);
			}
		}
	}
	process.stdout.write(`${out.join("\n")}\n`);
}

if (import.meta.main) {
	await main(parseArgs(process.argv.slice(2)));
}
