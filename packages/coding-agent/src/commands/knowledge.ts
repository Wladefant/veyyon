import { errorMessage } from "@veyyon/utils";
import { Args, Command, Flags } from "@veyyon/utils/cli";
import {
	KNOWLEDGE_ACTIONS,
	type KnowledgeAction,
	type KnowledgeCliArgs,
	runKnowledgeCliCommand,
} from "../cli/shared-knowledge-cli";

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
		from: Flags.string({ description: "Catalog directory for import, apply, pull, or diff" }),
		baseline: Flags.string({ description: "Path to custom baseline snapshot file" }),
		profile: Flags.string({ description: "Target profile name (defaults to active profile)" }),
		dryRun: Flags.boolean({ description: "Simulate operations without writing changes to disk", default: false }),
		preserveConflicts: Flags.boolean({
			description: "Preserve conflicting files as .conflict.<hash> files alongside target",
			default: true,
		}),
		json: Flags.boolean({ description: "Output results formatted as JSON", default: false }),
	};

	static examples = [
		"veyyon knowledge export --out ./catalog",
		"veyyon knowledge apply --from ./catalog",
		"veyyon knowledge pull --from ./catalog",
		"veyyon knowledge diff --from ./catalog",
		"veyyon knowledge verify ./catalog",
		"veyyon shared-knowledge export --out ./catalog",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Knowledge);
		const cmd: KnowledgeCliArgs = {
			action: (args.action ?? "status") as KnowledgeAction,
			path: args.path,
			out: flags.out,
			from: flags.from,
			baseline: flags.baseline,
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
