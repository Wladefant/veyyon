import * as path from "node:path";
import {
	getAgentDir,
	getGlobalConfigRootDir,
	getProfileRootDir,
} from "@veyyon/utils/dirs";
import { readCatalog } from "../shared-knowledge/catalog";
import {
	applyKnowledgeCatalog,
	diffKnowledgeCatalog,
	exportKnowledgeCatalog,
} from "../shared-knowledge/syncer";
import type {
	KnowledgeCategory,
} from "../shared-knowledge/types";

export type KnowledgeAction =
	| "export"
	| "import"
	| "apply"
	| "pull"
	| "diff"
	| "status"
	| "verify";

export const KNOWLEDGE_ACTIONS: KnowledgeAction[] = [
	"export",
	"import",
	"apply",
	"pull",
	"diff",
	"status",
	"verify",
];

export interface KnowledgeCliArgs {
	action: KnowledgeAction;
	path?: string;
	out?: string;
	from?: string;
	baseline?: string;
	categories?: string[];
	profile?: string;
	dryRun?: boolean;
	preserveConflicts?: boolean;
	json?: boolean;
}

function resolveRoots(profile?: string): {
	agentDir: string;
	globalDir: string;
	workflowsDir: string;
} {
	const globalDir = getGlobalConfigRootDir();
	const agentDir = profile
		? path.join(getProfileRootDir(profile), "agent")
		: getAgentDir();
	const workflowsDir = path.join(globalDir, "workflows");

	return { agentDir, globalDir, workflowsDir };
}

export async function runKnowledgeCliCommand(args: KnowledgeCliArgs): Promise<void> {
	const action = args.action ?? "status";
	const roots = resolveRoots(args.profile);

	switch (action) {
		case "export": {
			const outDir = args.out ?? args.path;
			if (!outDir) {
				throw new Error("Must specify output catalog directory with --out <dir> or positional argument");
			}

			const categories = args.categories as KnowledgeCategory[] | undefined;
			const result = await exportKnowledgeCatalog({
				outDir,
				agentDir: roots.agentDir,
				globalDir: roots.globalDir,
				workflowsDir: roots.workflowsDir,
				categories,
			});

			if (args.json) {
				console.log(JSON.stringify(result, null, 2));
			} else {
				console.log(`Exported ${result.exportedCount} knowledge items to ${outDir}`);
				console.log(`Manifest created: ${path.join(outDir, "manifest.json")}`);
			}
			break;
		}

		case "import":
		case "apply":
		case "pull": {
			const catalogDir = args.from ?? args.path;
			if (!catalogDir) {
				throw new Error(`Must specify catalog directory with --from <dir> or positional argument for ${action}`);
			}

			const categories = args.categories as KnowledgeCategory[] | undefined;
			const result = await applyKnowledgeCatalog({
				catalogDir,
				targetAgentDir: roots.agentDir,
				targetGlobalDir: roots.globalDir,
				targetWorkflowsDir: roots.workflowsDir,
				baselinePath: args.baseline,
				dryRun: args.dryRun,
				preserveConflicts: args.preserveConflicts ?? true,
				categories,
			});

			if (args.json) {
				console.log(JSON.stringify(result, null, 2));
			} else if (result.success) {
				console.log(`Successfully applied ${result.appliedCount} knowledge items from ${catalogDir}`);
				if (result.writtenFiles.length > 0) {
					console.log(`Files written:\n  - ${result.writtenFiles.join("\n  - ")}`);
				}
			} else {
				console.error(`Apply failed with ${result.conflictCount} conflict(s):`);
				for (const error of result.errors) {
					console.error(`  - ${error}`);
				}
				if (result.conflictFiles.length > 0) {
					console.error(`Preserved conflicting files:\n  - ${result.conflictFiles.join("\n  - ")}`);
				}
				process.exitCode = 1;
			}
			break;
		}

		case "diff":
		case "status": {
			const catalogDir = args.from ?? args.path;
			if (!catalogDir) {
				throw new Error("Must specify catalog directory with --from <dir> or positional argument for diff/status");
			}

			const comparison = await diffKnowledgeCatalog({
				catalogDir,
				targetAgentDir: roots.agentDir,
				targetGlobalDir: roots.globalDir,
				targetWorkflowsDir: roots.workflowsDir,
				baselinePath: args.baseline,
			});

			if (args.json) {
				console.log(JSON.stringify(comparison, null, 2));
			} else {
				console.log(`Comparison against catalog: ${catalogDir}`);
				console.log(`  Can apply cleanly: ${comparison.canApply}`);
				console.log(`  Creates: ${comparison.creates.length}`);
				console.log(`  Updates: ${comparison.updates.length}`);
				console.log(`  Unchanged: ${comparison.unchanged.length}`);
				console.log(`  Conflicts: ${comparison.conflicts.length}`);
				console.log(`  Deletes: ${comparison.deletes.length}`);
				console.log(`  Shadowed (precedence): ${comparison.shadowed.length}`);

				if (comparison.conflicts.length > 0) {
					console.error("\nConflicts:");
					for (const c of comparison.conflicts) {
						console.error(`  - ${c.item.relativePath}: ${c.reason ?? "Divergent content"}`);
					}
					process.exitCode = 1;
				}
			}
			break;
		}

		case "verify": {
			const catalogDir = args.from ?? args.path;
			if (!catalogDir) {
				throw new Error("Must specify catalog directory with --from <dir> or positional argument for verify");
			}

			const { manifest, files } = await readCatalog(catalogDir);
			if (args.json) {
				console.log(
					JSON.stringify(
						{
							valid: true,
							itemCount: manifest.items.length,
							categories: manifest.categories,
							generator: manifest.generator,
							createdAt: manifest.createdAt,
						},
						null,
						2,
					),
				);
			} else {
				console.log(`Catalog at ${catalogDir} verified successfully.`);
				console.log(`  Total items: ${manifest.items.length}`);
				console.log(`  Files verified: ${files.size}`);
				console.log(`  Categories: ${manifest.categories.join(", ")}`);
				console.log(`  Generator: ${manifest.generator} (${manifest.generatorVersion})`);
			}
			break;
		}

		default:
			throw new Error(`Unknown knowledge action: ${action as string}`);
	}
}
