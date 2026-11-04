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
	readonly cohortSize: 80 | 100;
}

/** Refuse an unapplied resource treatment even when a caller supplies an already-built plan. */
export function requireSkillArmSupport(variants: readonly Variant[], backend: string): void {
	if (variants.some(variant => variant.skillArm && (backend !== "in-process" || variant.harness !== "veyyon"))) {
		throw new Error("Skill experiments require the veyyon in-process resource snapshot boundary.");
	}
}

async function hashSources(roots: readonly string[]): Promise<string> {
	const files: { file: string; label: string }[] = [];
	const excludedDirectories: Record<string, true> = { node_modules: true, ".git": true, ".cache": true, dist: true };
	const collect = async (file: string, label: string): Promise<void> => {
		const stat = await fs.lstat(file);
		if (stat.isSymbolicLink()) throw new Error(`Experiment source identity refuses symbolic link: ${label}`);
		if (stat.isDirectory()) {
			const entries = await fs.readdir(file, { withFileTypes: true });
			for (const entry of entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0)) {
				if (entry.isDirectory() && excludedDirectories[entry.name]) continue;
				if (entry.isSymbolicLink()) throw new Error(`Experiment source identity refuses symbolic link: ${label}/${entry.name}`);
				const child = path.join(file, entry.name);
				const childLabel = `${label}/${entry.name}`;
				if (entry.isDirectory()) await collect(child, childLabel);
				else if (entry.isFile() && /\.(?:ts|tsx|js|json|md)$/.test(entry.name)) files.push({ file: child, label: childLabel });
			}
		} else if (/\.(?:ts|tsx|js|json|md)$/.test(file)) {
			files.push({ file, label });
		}
	};
	for (let index = 0; index < roots.length; index++) await collect(roots[index], String(index));
	const hash = createHash("sha256");
	// Keep reads bounded, but consume bytes in source order so scheduling never changes identity.
	for (let offset = 0; offset < files.length; offset += 32) {
		const batch = files.slice(offset, offset + 32);
		const contents = await Promise.all(batch.map(entry => fs.readFile(entry.file)));
		for (let index = 0; index < batch.length; index++) {
			const { label } = batch[index];
			const bytes = contents[index];
			hash.update(`${label.length}:${label}:${bytes.length}:`);
			hash.update(bytes);
		}
	}
	return hash.digest("hex");
}

/** Freeze the source tree and resource recipes that this skill experiment actually executes. */
export async function bindSkillExperiment(
	variants: readonly Variant[],
	provenance: SuiteProvenance,
	criteria?: { readonly minimumImprovement: number },
	cohortSize: 80 | 100 = 100,
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
		armFingerprint: computeVariantFingerprint({
			config: {
				cohortSize,
				variants: variants.map(variant => ({
					harness: variant.harness,
					model: variant.model,
					skill: variant.skillArm,
				})),
			},
		}),
		cohortSize,
	});
}
