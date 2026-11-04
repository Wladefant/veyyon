/**
 * CLI command to manage and rotate live terminal control session credentials.
 */
import { errorMessage } from "@veyyon/utils";
import { Args, Command } from "@veyyon/utils/cli";
import { rotateTerminalControl } from "../launch/terminal-control-client";

export default class TerminalControl extends Command {
	static description = "Manage and rotate terminal control session credentials";

	static args = {
		action: Args.string({
			description: "Terminal control action (rotate)",
			required: true,
			options: ["rotate"],
		}),
		"session-id": Args.string({
			description: "Session ID of the target terminal",
			required: true,
		}),
	};

	static flags = {};

	static examples = [
		"# Rotate credentials for a live terminal session\n  veyyon terminal-control rotate s-12345",
	];

	async run(): Promise<void> {
		const { args } = await this.parse(TerminalControl);
		const action = typeof args.action === "string" ? args.action : undefined;
		const sessionId = typeof args["session-id"] === "string" ? args["session-id"] : undefined;

		if (action !== "rotate") {
			process.stderr.write(`Error: Unknown action "${action ?? ""}". Expected "rotate".\n`);
			process.exitCode = 1;
			return;
		}

		if (!sessionId) {
			process.stderr.write("Error: Missing required argument: session-id\n");
			process.exitCode = 1;
			return;
		}

		try {
			await rotateTerminalControl(sessionId);
			process.stdout.write("Rotation succeeded.\n");
		} catch (error) {
			const message = errorMessage(error);
			process.stderr.write(`Error: ${message}\n`);
			process.exitCode = 1;
		}
	}
}
