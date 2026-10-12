import { errorMessage, getProjectDir } from "@veyyon/utils";
/**
 * Study and recover a stored session: `veyyon session stats [id]`.
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { runCheckpointCommand } from "../cli/checkpoint-cli";
import { runSessionStatsCommand } from "../cli/session-stats-cli";
import { Settings } from "../config/settings";

const SESSION_ACTIONS = [
	"stats",
	"checkpoint-status",
	"checkpoint-export",
	"checkpoint-restore",
	"checkpoint-fork",
] as const;

export default class Session extends Command {
	static description = "Study and recover a stored session";
	static aliases = ["sessions"];

	static args = {
		action: Args.string({
			description: "Session action",
			required: false,
			options: SESSION_ACTIONS,
			default: "stats",
		}),
		id: Args.string({
			description: "Session id or filename prefix (defaults to the most recent session in this directory)",
			required: false,
		}),
	};
	static flags = {
		json: Flags.boolean({ char: "j", description: "Output the full report as JSON", default: false }),
		output: Flags.string({ description: "Restore into this new directory" }),
		file: Flags.string({ description: "Native session JSONL file to export" }),
		workspace: Flags.string({ description: "Approved workspace file or directory to include", multiple: true }),
	};

	static examples = [
		"veyyon session stats",
		"veyyon session stats 3f8a",
		"veyyon session checkpoint-export --file ./session.jsonl --workspace src",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Session);
		try {
			if (args.action !== "stats") {
				await Settings.init({ cwd: getProjectDir() });
				const action =
					args.action === "checkpoint-status"
						? "status"
						: args.action === "checkpoint-export"
							? "export"
							: args.action === "checkpoint-restore"
								? "restore"
								: "fork";
				await runCheckpointCommand({
					action,
					id: args.id,
					output: flags.output,
					sessionFile: flags.file,
					workspace: flags.workspace,
				});
				return;
			}
			await runSessionStatsCommand({ id: args.id, json: flags.json });
		} catch (error) {
			console.error(errorMessage(error));
			process.exitCode = 1;
		}
	}
}
