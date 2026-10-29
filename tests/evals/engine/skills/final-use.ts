import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { canonicalizeConfig } from "../plan/variant-matrix";

function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}

export interface FinalUseIdentity {
	readonly sourceHash: string;
	readonly datasetFingerprint: string;
	readonly splitFingerprint: string;
	readonly model: string;
	readonly harness: string;
	readonly grader: string;
}

export interface FinalSkillCandidateDeclaration {
	readonly candidateHash: string;
	readonly sourceHash: string;
	readonly resolvedModel: { readonly provider: string; readonly id: string; readonly version: string | null };
	readonly binding: Readonly<Record<string, unknown>>;
}

export interface FinalSkillSelectionDeclaration {
	readonly winner: "candidate" | "incumbent";
	readonly candidateHash: string;
	readonly sourceHash: string;
	readonly binding: Readonly<Record<string, unknown>>;
	readonly scoreRunHash: string;
	readonly minimumImprovement: number;
	readonly score: {
		readonly selected: string;
		readonly reason: string;
		readonly incumbentMean: number | null;
		readonly candidateMean: number | null;
	};
}

export interface FinalSkillUseDeclaration {
	readonly identity: FinalUseIdentity;
	readonly candidate: FinalSkillCandidateDeclaration;
	readonly selection: FinalSkillSelectionDeclaration;
	readonly executionFingerprint: string;
	readonly resume?: boolean;
}

const verifiedSelections = new WeakSet<object>();

export function markFinalSkillSelectionVerified(selection: object): void {
	if (!Object.isFrozen(selection)) throw new Error("Verified skill selections must be frozen before use.");
	verifiedSelections.add(selection);
}

export function isVerifiedFinalSkillSelection(selection: unknown): selection is FinalSkillSelectionDeclaration {
	return typeof selection === "object" && selection !== null && verifiedSelections.has(selection);
}

export function finalExecutionFingerprint(input: {
	readonly planIdentity: string;
	readonly runId: string;
	readonly runsDir: string;
	readonly tasks: readonly string[];
	readonly repeats: number;
	readonly cells: readonly { readonly variant: string; readonly suite: string; readonly task: string; readonly repeat: number }[];
	readonly options: Readonly<Record<string, unknown>>;
	readonly jobs: number;
}): string {
	return digest(
		canonicalizeConfig({
			planIdentity: input.planIdentity,
			runId: input.runId,
			runsDir: path.resolve(input.runsDir),
			tasks: [...input.tasks].sort(),
			repeats: input.repeats,
			cells: input.cells,
			options: input.options,
			jobs: input.jobs,
		}),
	);
}

/** Persist an exclusive claim. A claim is never released, including after failed execution. */
export async function claimFinalSkillUse(
	claimsDir: string,
	identity: FinalUseIdentity,
	details: { readonly candidateHash: string; readonly executionFingerprint: string; readonly resume?: boolean },
): Promise<string> {
	for (const [key, value] of Object.entries(identity)) if (!value) throw new Error(`Final-use claim requires ${key}.`);
	const claimKey = digest(canonicalizeConfig(identity));
	const target = path.join(path.resolve(claimsDir), `${claimKey}.json`);
	await fs.mkdir(path.dirname(target), { recursive: true });
	let handle: fs.FileHandle;
	try {
		handle = await fs.open(target, "wx", 0o600);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST" || !details.resume) throw error;
		const prior = JSON.parse(await fs.readFile(target, "utf8")) as {
			version?: number;
			identity?: FinalUseIdentity;
			candidateHash?: string;
			executionFingerprint?: string;
		};
		if (
			prior.version !== 1 ||
			canonicalizeConfig(prior.identity) !== canonicalizeConfig(identity) ||
			prior.executionFingerprint !== details.executionFingerprint ||
			prior.candidateHash !== details.candidateHash
		) {
			throw error;
		}
		return target;
	}
	try {
		await handle.writeFile(
			`${JSON.stringify(
				{
					version: 1,
					identity,
					candidateHash: details.candidateHash,
					executionFingerprint: details.executionFingerprint,
					claimedAt: new Date().toISOString(),
				},
				null,
				2,
			)}\n`,
			"utf8",
		);
		await handle.sync();
	} finally {
		await handle.close();
	}
	return target;
}

/** Exclude concurrent final executions while allowing a matching journal resume after a crash. */
export async function acquireFinalSkillRunLock(claimPath: string, executionFingerprint: string): Promise<() => Promise<void>> {
	const lockPath = `${claimPath}.lock`;
	const token = `${process.pid}:${digest(`${Date.now()}:${Math.random()}`)}`;
	const writeLock = async () => {
		const handle = await fs.open(lockPath, "wx", 0o600);
		try {
			await handle.writeFile(JSON.stringify({ pid: process.pid, executionFingerprint, token }), "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
	};
	try {
		await writeLock();
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		const recoveryPath = `${lockPath}.recovery`;
		let recoveryHandle: fs.FileHandle;
		try {
			recoveryHandle = await fs.open(recoveryPath, "wx", 0o600);
		} catch (recoveryError) {
			if ((recoveryError as NodeJS.ErrnoException).code === "EEXIST") {
				throw new Error("A final-use lock recovery is already active; refusing concurrent execution.");
			}
			throw recoveryError;
		}
		try {
			try {
				await recoveryHandle.writeFile(JSON.stringify({ pid: process.pid, token }), "utf8");
				await recoveryHandle.sync();
			} finally {
				await recoveryHandle.close();
			}
			let owner: { pid?: number; executionFingerprint?: string } | null = null;
			try {
				owner = JSON.parse(await fs.readFile(lockPath, "utf8"));
			} catch (readError) {
				if ((readError as NodeJS.ErrnoException).code !== "ENOENT") {
					throw new Error("A final-use execution lock exists but cannot be read; refusing concurrent execution.");
				}
			}
			if (owner) {
				let alive = false;
				if (typeof owner.pid === "number" && Number.isInteger(owner.pid) && owner.pid > 0) {
					try {
						process.kill(owner.pid, 0);
						alive = true;
					} catch (probeError) {
						alive = (probeError as NodeJS.ErrnoException).code === "EPERM";
					}
				}
				if (alive) throw new Error("The final-use claim is already executing.");
				await fs.rm(lockPath);
			}
			await writeLock();
		} finally {
			await fs.rm(recoveryPath, { force: true });
		}
	}
	return async () => {
		const owner = JSON.parse(await fs.readFile(lockPath, "utf8")) as { token?: string };
		if (owner.token !== token) throw new Error("Final-use execution lock ownership changed.");
		await fs.rm(lockPath);
	};
}
