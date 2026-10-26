import { errorMessage } from "@veyyon/utils";
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { KNOWLEDGE_CATEGORIES, type KnowledgeCategory } from "../shared-knowledge/types";
import {
	KNOWLEDGE_ACTIONS,
	type KnowledgeAction,
	type KnowledgeCliArgs,
	runKnowledgeCliCommand,
} from "../cli/shared-knowledge-cli";

function parseCategories(value?: string): KnowledgeCategory[] | undefined {
	if (value === undefined) return undefined;
	const categories = value.split(",").map((category) => category.trim());
	if (
		categories.length === 0 ||
		categories.some((category) => !KNOWLEDGE_CATEGORIES.includes(category as KnowledgeCategory))
	) {
		throw new Error(`Invalid --categories value. Expected comma-separated values from: ${KNOWLEDGE_CATEGORIES.join(", ")}`);
	}
	return [...new Set(categories)] as KnowledgeCategory[];
}


export default class Knowledge extends Command {
	static description = "Manage and synchronize shared text knowledge (skills, rules, workflows, lessons, config)";

	static aliases = ["shared-knowledge"];

	static args = {
		action: Args.string({
			description: "Knowledge action",
			required: false,
			options: KNOWLEDGE_ACTIONS,
			default: "status",
		}),
		path: Args.string({
			description: "Catalog directory path",
			required: false,
		}),
	};

	static flags = {
		out: Flags.string({ description: "Output directory for export" }),
		plan: Flags.string({ description: "Write a candidate manifest for human review; do not export files" }),
		"reviewed-plan": Flags.string({ description: "Export only unchanged files listed in this reviewed manifest" }),
		from: Flags.string({ description: "Catalog directory for import, apply, pull, or diff" }),
		baseline: Flags.string({ description: "Path to custom baseline snapshot file" }),
		categories: Flags.string({
			description: "Comma-separated knowledge categories to export or apply",
		}),
		profile: Flags.string({ description: "Target profile name (defaults to active profile)" }),
		dryRun: Flags.boolean({ description: "Simulate operations without writing changes to disk", default: false }),
		preserveConflicts: Flags.boolean({
			description: "Preserve conflicting files as .conflict.<hash> files alongside target",
			default: true,
		}),
		json: Flags.boolean({ description: "Output results formatted as JSON", default: false }),
	};

	static examples = [
		"veyyon knowledge apply --from ./catalog --categories skills,rules",
		"veyyon knowledge export --plan ./review-plan.json",
		"veyyon knowledge export --out ./catalog --reviewed-plan ./review-plan.json",
		"veyyon knowledge apply --from ./catalog",
		"veyyon knowledge pull --from ./catalog",
		"veyyon knowledge diff --from ./catalog",
		"veyyon knowledge verify ./catalog",
		"veyyon shared-knowledge export --out ./catalog --reviewed-plan ./review-plan.json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Knowledge);
		const cmd: KnowledgeCliArgs = {
			action: (args.action ?? "status") as KnowledgeAction,
			path: args.path,
			out: flags.out,
			plan: flags.plan,
			reviewedPlan: flags["reviewed-plan"],
			from: flags.from,
			baseline: flags.baseline,
			categories: parseCategories(flags.categories),
			profile: flags.profile,
			dryRun: flags.dryRun,
			preserveConflicts: flags.preserveConflicts,
			json: flags.json,
		};

		try {
			await runKnowledgeCliCommand(cmd);
		} catch (error) {
			const message = errorMessage(error);
			console.error(message);
			process.exitCode = 1;
		}
	}
}
