#!/usr/bin/env bun

import * as nodeChildProcess from "node:child_process";
import * as nodeFs from "node:fs/promises";
import * as nodePath from "node:path";
import {
	AFFECTED_SELECTOR_ID,
	buildWorkspaceGraphWithImports,
	selectAffectedWorkspaceMembers,
	type AffectedWorkspaceInspection,
	type ChangedPathRecord,
	type WorkspaceSourceFile,
} from "../../scripts/affected-workspace-tests";
import { buildAffectedTestPlan } from "../../scripts/ci-test-ts";
import { resolveWorkspaceMemberDirectories } from "../../scripts/workspace-layout";

const repoRoot = nodePath.resolve(import.meta.dirname, "../..");
const fixturePath = nodePath.join(import.meta.dirname, "affected-selection-pr-inputs.json");
const MAX_GIT_OUTPUT_BYTES = 128 * 1024 * 1024;
const EXPECTED_PR_NUMBERS = [620, 627, 607];
const SHARED_PR_NUMBER = 607;
const FULL_SHA = /^[0-9a-f]{40}$/i;
const SOURCE_MODULE_EXTENSION = /\.(?:[cm]?[jt]sx?)$/i;
const EVIDENCE_SCOPE =
	"Replayed recorded PR file-list selection against the current committed workspace/import graph; this does not prove historical PR test coverage.";

interface PullRequestFile {
	filename: string;
	status: string;
	sha: string;
	previous_filename: string | null;
	additions: number;
	deletions: number;
	changes: number;
}

interface PullRequestInput {
	number: number;
	url: string;
	base_ref: string;
	base_sha: string;
	head_ref: string;
	head_sha: string;
	file_count: number;
	files: PullRequestFile[];
}

interface InputFixture {
	repository: string;
	pull_requests: PullRequestInput[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(record: Record<string, unknown>, key: string, subject: string): string {
	const value = record[key];
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(`${subject}.${key} must be a non-empty string`);
	}
	return value;
}

function requiredNonnegativeInteger(record: Record<string, unknown>, key: string, subject: string): number {
	const value = record[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
		throw new Error(`${subject}.${key} must be a non-negative integer`);
	}
	return value;
}

function parseInputFixture(value: unknown): InputFixture {
	if (!isRecord(value)) throw new Error("PR input fixture must be a JSON object");
	if (value.repository !== "Wladefant/veyyon") throw new Error("PR input fixture repository must be Wladefant/veyyon");
	if (!Array.isArray(value.pull_requests)) throw new Error("PR input fixture pull_requests must be an array");

	const pullRequests = value.pull_requests.map((input: unknown, index): PullRequestInput => {
		const subject = `pull_requests[${index}]`;
		if (!isRecord(input)) throw new Error(`${subject} must be an object`);
		const number = requiredNonnegativeInteger(input, "number", subject);
		const baseSha = requiredString(input, "base_sha", subject);
		const headSha = requiredString(input, "head_sha", subject);
		if (!FULL_SHA.test(baseSha) || !FULL_SHA.test(headSha)) {
			throw new Error(`${subject} must carry full recorded base and head commit SHAs`);
		}
		if (!Array.isArray(input.files)) throw new Error(`${subject}.files must be an array`);

		const files = input.files.map((fileInput: unknown, fileIndex): PullRequestFile => {
			const fileSubject = `${subject}.files[${fileIndex}]`;
			if (!isRecord(fileInput)) throw new Error(`${fileSubject} must be an object`);
			const previousFilename = fileInput.previous_filename;
			if (previousFilename !== null && (typeof previousFilename !== "string" || previousFilename.length === 0)) {
				throw new Error(`${fileSubject}.previous_filename must be null or a non-empty string`);
			}
			const sha = requiredString(fileInput, "sha", fileSubject);
			if (!FULL_SHA.test(sha)) throw new Error(`${fileSubject}.sha must be a full blob SHA`);
			return {
				filename: requiredString(fileInput, "filename", fileSubject),
				status: requiredString(fileInput, "status", fileSubject),
				sha,
				previous_filename: previousFilename,
				additions: requiredNonnegativeInteger(fileInput, "additions", fileSubject),
				deletions: requiredNonnegativeInteger(fileInput, "deletions", fileSubject),
				changes: requiredNonnegativeInteger(fileInput, "changes", fileSubject),
			};
		});
		const fileCount = requiredNonnegativeInteger(input, "file_count", subject);
		if (files.length !== fileCount) throw new Error(`${subject}.file_count does not match its recorded files`);
		if (new Set(files.map(file => file.filename)).size !== files.length) {
			throw new Error(`${subject}.files contains duplicate filenames`);
		}

		return {
			number,
			url: requiredString(input, "url", subject),
			base_ref: requiredString(input, "base_ref", subject),
			base_sha: baseSha,
			head_ref: requiredString(input, "head_ref", subject),
			head_sha: headSha,
			file_count: fileCount,
			files,
		};
	});

	if (pullRequests.length !== EXPECTED_PR_NUMBERS.length) {
		throw new Error(`expected ${EXPECTED_PR_NUMBERS.length} recorded PRs, found ${pullRequests.length}`);
	}
	for (let index = 0; index < EXPECTED_PR_NUMBERS.length; index += 1) {
		if (pullRequests[index]?.number !== EXPECTED_PR_NUMBERS[index]) {
			throw new Error(`expected recorded PR ${EXPECTED_PR_NUMBERS[index]} at position ${index + 1}`);
		}
	}
	return { repository: "Wladefant/veyyon", pull_requests: pullRequests };
}

function git(args: readonly string[], input?: Uint8Array): Buffer {
	return nodeChildProcess.execFileSync("git", [...args], {
		cwd: repoRoot,
		input,
		timeout: 30_000,
	});
}

function committedRevision(): string {
	const dirtyTrackedFiles = git(["status", "--porcelain=v1", "--untracked-files=no"]).toString("utf8").trim();
	if (dirtyTrackedFiles.length > 0) {
		throw new Error("tracked working-tree changes prevent proving the committed workspace/import graph");
	}
	const revision = git(["rev-parse", "--verify", "HEAD^{commit}"]).toString("utf8").trim().toLowerCase();
	if (!FULL_SHA.test(revision)) throw new Error("HEAD is not an available full commit SHA");
	return revision;
}

function committedPaths(revision: string): string[] {
	return git(["ls-tree", "-r", "--name-only", "-z", revision])
		.toString("utf8")
		.split("\0")
		.filter(path => path.length > 0);
}

function readCommittedBlobs(revision: string, paths: readonly string[]): Map<string, Buffer> {
	if (paths.some(path => path.includes("\n") || path.includes("\r"))) {
		throw new Error("source path cannot be represented in a Git batch request");
	}
	if (paths.length === 0) return new Map();
	const output = git(
		["cat-file", "--batch"],
		Buffer.from(paths.map(path => `${revision}:${path}\n`).join("")),
	);
	const blobs = new Map<string, Buffer>();
	let offset = 0;
	for (const path of paths) {
		const headerEnd = output.indexOf(10, offset);
		if (headerEnd < 0) throw new Error(`missing Git blob header for ${revision}:${path}`);
		const [objectId, type, sizeText] = output.toString("ascii", offset, headerEnd).split(" ");
		const size = Number(sizeText);
		if (!objectId || type !== "blob" || !Number.isSafeInteger(size) || size < 0) {
			throw new Error(`invalid Git blob header for ${revision}:${path}`);
		}
		const contentStart = headerEnd + 1;
		const contentEnd = contentStart + size;
		if (contentEnd >= output.length || output[contentEnd] !== 10) {
			throw new Error(`truncated Git blob body for ${revision}:${path}`);
		}
		blobs.set(path, output.subarray(contentStart, contentEnd));
		offset = contentEnd + 1;
	}
	if (offset !== output.length) throw new Error(`unexpected trailing Git blob data at ${revision}`);
	return blobs;
}

function currentImportGraph(revision: string) {
	const availablePaths = committedPaths(revision);
	const rootManifestValue: unknown = JSON.parse(git(["show", `${revision}:package.json`]).toString("utf8"));
	if (!isRecord(rootManifestValue)) throw new Error(`${revision}:package.json is not a JSON object`);
	const directories = resolveWorkspaceMemberDirectories(
		rootManifestValue,
		availablePaths.filter(path => path.endsWith("/package.json")),
	);
	const uncommittedPlannerFiles = git([
		"status",
		"--porcelain=v1",
		"--untracked-files=all",
		"--",
		...directories,
		"scripts",
	])
		.toString("utf8")
		.trim();
	if (uncommittedPlannerFiles.length > 0) {
		throw new Error("workspace or planner files contain uncommitted paths");
	}
	const manifestPaths = directories.map(directory => `${directory}/package.json`);
	const sourcePaths = availablePaths
		.filter(
			path =>
				SOURCE_MODULE_EXTENSION.test(path) &&
				directories.some(directory => path.startsWith(`${directory}/`)),
		)
		.sort();
	const blobs = readCommittedBlobs(revision, [...manifestPaths, ...sourcePaths]);
	const entries = directories.map(directory => {
		const manifestPath = `${directory}/package.json`;
		const manifestBytes = blobs.get(manifestPath);
		if (manifestBytes === undefined) throw new Error(`missing Git manifest blob for ${revision}:${manifestPath}`);
		const manifestValue: unknown = JSON.parse(manifestBytes.toString("utf8"));
		if (!isRecord(manifestValue)) throw new Error(`${revision}:${manifestPath} is not a JSON object`);
		return { directory, manifest: manifestValue };
	});
	const sources: WorkspaceSourceFile[] = sourcePaths.map(path => {
		const sourceBlob = blobs.get(path);
		if (sourceBlob === undefined) throw new Error(`missing Git source blob for ${revision}:${path}`);
		return { path, contents: sourceBlob.toString("utf8") };
	});
	const result = buildWorkspaceGraphWithImports(entries, sources, availablePaths, repoRoot);
	if (result.fallbackReason !== undefined) {
		throw new Error(`cannot prove the current committed workspace/import graph: ${result.fallbackReason}`);
	}
	return { ...result, committedPathSet: new Set(availablePaths) };
}

function changedRecords(pullRequest: PullRequestInput): ChangedPathRecord[] {
	return pullRequest.files.map(file => ({
		status: file.status,
		paths:
			file.previous_filename === null || file.previous_filename === file.filename
				? [file.filename]
				: [file.previous_filename, file.filename],
	}));
}

async function main(): Promise<void> {
	const fixture = parseInputFixture(JSON.parse(await nodeFs.readFile(fixturePath, "utf8")) as unknown);
	const verificationHeadSha = committedRevision();
	const graph = currentImportGraph(verificationHeadSha);
	const receipts: Array<{ pullRequestNumber: number; selectionMode: "affected" | "full" }> = [];

	for (const pullRequest of fixture.pull_requests) {
		// Replay both selector revisions against the same immutable current-head graph.
		const selection = selectAffectedWorkspaceMembers(
			changedRecords(pullRequest),
			graph.graph,
			graph.graph,
			graph.importEdgeCount * 2,
		);
		const inspection: AffectedWorkspaceInspection = {
			...selection,
			selectorId: AFFECTED_SELECTOR_ID,
			baseSha: verificationHeadSha,
			headSha: verificationHeadSha,
			importEdgeCountsByRevision: {
				base: graph.importEdgeCount,
				head: graph.importEdgeCount,
			},
		};
		const plan = await buildAffectedTestPlan(inspection);
		if (plan.selectedInventory.some(file => !graph.committedPathSet.has(file))) {
			throw new Error(`PR #${pullRequest.number} plan includes files absent from verification HEAD`);
		}
		const receipt = {
			type: "affected-selection-replay",
			repository: fixture.repository,
			pullRequestNumber: pullRequest.number,
			url: pullRequest.url,
			base: { ref: pullRequest.base_ref, sha: pullRequest.base_sha },
			head: { ref: pullRequest.head_ref, sha: pullRequest.head_sha },
			fileCount: pullRequest.file_count,
			files: pullRequest.files.map(file => ({
				path: file.filename,
				status: file.status,
				sha: file.sha,
				previousPath: file.previous_filename,
			})),
			verificationHeadSha,
			plannerComparison: { baseSha: plan.baseSha, headSha: plan.headSha },
			evidenceScope: EVIDENCE_SCOPE,
			selectionMode: plan.mode,
			fallback: plan.fallbackReason ?? null,
			selectedMembers: plan.selectedMembers,
			selectedMemberCount: plan.selectedMembers.length,
			selectedTestFileCount: plan.selectedInventory.length,
			chunkCount: plan.chunks.length,
			chunks: plan.chunks.map(chunk => ({ label: chunk.label, cwd: chunk.cwd, fileCount: chunk.files.length })),
			selectionHash: plan.selectionHash,
		};
		process.stdout.write(`AFFECTED_SELECTION_REPLAY ${JSON.stringify(receipt)}\n`);
		receipts.push({ pullRequestNumber: pullRequest.number, selectionMode: plan.mode });
	}

	const sharedReceipt = receipts.find(receipt => receipt.pullRequestNumber === SHARED_PR_NUMBER);
	if (sharedReceipt?.selectionMode !== "full") {
		throw new Error(`shared contract PR #${SHARED_PR_NUMBER} must select full mode`);
	}
	const affectedNonShared = receipts.filter(
		receipt => receipt.pullRequestNumber !== SHARED_PR_NUMBER && receipt.selectionMode === "affected",
	);
	if (affectedNonShared.length === 0) {
		throw new Error("at least one non-shared PR must select affected mode; all selections were full");
	}
	process.stdout.write(
		`AFFECTED_SELECTION_REPLAY_COMPLETE ${JSON.stringify({
			verificationHeadSha,
			receiptCount: receipts.length,
			affectedNonSharedPrCount: affectedNonShared.length,
			sharedPrNumber: SHARED_PR_NUMBER,
			sharedSelectionMode: sharedReceipt.selectionMode,
		})}\n`,
	);
}

main().catch(error => {
	const message = error instanceof Error ? error.message : String(error);
	process.stderr.write(`AFFECTED_SELECTION_REPLAY_FAILED ${message}\n`);
	process.exitCode = 1;
});
