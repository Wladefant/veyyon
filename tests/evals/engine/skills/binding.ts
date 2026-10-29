import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { SuiteProvenance, Variant } from "../contracts";
import { evalsPackageDir, repoRootDir, requirePathSegment } from "../package-paths";
import { computeVariantFingerprint } from "../plan/variant-matrix";

/** Content identity, not a claim that an upstream rolling model alias has not changed. */
export interface SkillExperimentBinding {
	readonly version: 1;
	readonly buildHash: string;
	readonly registryHash: string;
	readonly graderHash: string;
	readonly suiteIdentity: SuiteProvenance;
	readonly requestedModels: readonly string[];
	readonly modelRevision: null;
	readonly criteriaHash: string | null;
	readonly armFingerprint: string;
}

async function hashSources(roots: readonly string[]): Promise<string> {
	const hash = createHash("sha256");
	const visit = async (file: string, label: string): Promise<void> => {
		const stat = await fs.lstat(file);
		if (stat.isSymbolicLink()) throw new Error(`Experiment source identity refuses symbolic link: ${label}`);
		if (stat.isDirectory()) {
			for (const entry of (await fs.readdir(file)).sort()) await visit(path.join(file, entry), `${label}/${entry}`);
		} else if (/\.(?:ts|tsx|js|json|md)$/.test(file)) {
			const bytes = await fs.readFile(file);
			hash.update(`${label.length}:${label}:${bytes.length}:`);
			hash.update(bytes);
		}
	};
	for (let index = 0; index < roots.length; index++) await visit(roots[index], String(index));
	return hash.digest("hex");
}

/** Freeze the source tree and resource recipes that this skill experiment actually executes. */
export async function bindSkillExperiment(
	variants: readonly Variant[],
	provenance: SuiteProvenance,
	criteria?: { readonly minimumImprovement: number },
): Promise<SkillExperimentBinding> {
	if (criteria && (!Number.isFinite(criteria.minimumImprovement) || criteria.minimumImprovement < 0)) {
		throw new Error("Skill selection criteria require a finite minimumImprovement >= 0.");
	}
	const root = repoRootDir();
	const evals = evalsPackageDir();
	const suite = requirePathSegment(provenance.suite, "suite");
	const [buildHash, registryHash, graderHash] = await Promise.all([
		hashSources([
			path.join(root, "packages", "coding-agent", "src"),
			path.join(root, "packages", "agent", "src"),
			path.join(root, "packages", "ai", "src"),
			path.join(root, "packages", "catalog", "src"),
			path.join(root, "packages", "utils", "src"),
			path.join(root, "contracts"),
			path.join(root, "kernel"),
			path.join(root, "package.json"),
			path.join(evals, "evals.ts"),
			path.join(evals, "engine"),
			path.join(evals, "backends", "in-process"),
		]),
		hashSources([path.join(evals, "harnesses"), path.join(evals, "engine", "members")]),
		hashSources([path.join(evals, "suites", suite)]),
	]);
	return Object.freeze({
		version: 1,
		buildHash,
		registryHash,
		graderHash,
		suiteIdentity: provenance,
		requestedModels: Object.freeze([...new Set(variants.map(variant => variant.model))].sort()),
		modelRevision: null,
		criteriaHash: criteria ? computeVariantFingerprint({ config: criteria }) : null,
		armFingerprint: computeVariantFingerprint({ config: variants.map(variant => ({
			harness: variant.harness,
			model: variant.model,
			skill: variant.skillArm,
		})) }),
	});
}
