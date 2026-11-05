import { getSSHConfigPath } from "@veyyon/utils";
import { addSSHHost, readSSHConfigFile, removeSSHHost } from "../../ssh/config-writer";
import type { ParsedSlashCommand, SlashCommandResult, SlashCommandRuntime } from "../types";
import { commandConsumed, errorMessage, parseSubcommand, usage } from "./parse";
import { parseSshAddArgs, parseSshRemoveArgs, SSH_ADD_USAGE } from "./ssh-args";

const SSH_HELP_TEXT = [
	"SSH host management (ACP mode)",
	`  ${SSH_ADD_USAGE.replace("Usage: ", "")}`,
	"  /ssh list                     List configured SSH hosts",
	"  /ssh remove <name>            Remove an SSH host",
	"  /ssh help                     Show this help",
].join("\n");

async function handleListCommand(runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	try {
		const config = await readSSHConfigFile(getSSHConfigPath());
		const entries = Object.entries(config.hosts ?? {});
		if (entries.length === 0) {
			await runtime.output("No SSH hosts configured.");
			return commandConsumed();
		}
		await runtime.output(
			entries
				.map(([name, host]) => `${name} | ${host.host} | ${host.username ?? "-"} | ${host.port ?? 22}`)
				.join("\n"),
		);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to list SSH hosts: ${errorMessage(err)}`, runtime);
	}
}

async function handleRemoveCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const request = parseSshRemoveArgs(rest);
	if ("error" in request) return usage(request.error, runtime);
	try {
		await removeSSHHost(getSSHConfigPath(), request.name);
		await runtime.session.refreshSshTool();
		await runtime.output(`Removed SSH host "${request.name}".`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to remove SSH host: ${errorMessage(err)}`, runtime);
	}
}

async function handleAddCommand(rest: string, runtime: SlashCommandRuntime): Promise<SlashCommandResult> {
	const request = parseSshAddArgs(rest);
	if ("error" in request) return usage(request.error, runtime);
	try {
		await addSSHHost(getSSHConfigPath(), request.name, request.config);
		await runtime.session.refreshSshTool({ activateIfAvailable: true });
		await runtime.output(`Added SSH host "${request.name}".`);
		return commandConsumed();
	} catch (err) {
		return usage(`Failed to add SSH host: ${errorMessage(err)}`, runtime);
	}
}

/** ACP/text-mode `/ssh` handler. Shared by both dispatchers via the spec. */
export async function handleSshAcp(
	command: ParsedSlashCommand,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	const { verb, rest } = parseSubcommand(command.args);
	if (!verb || verb === "help") {
		await runtime.output(SSH_HELP_TEXT);
		return commandConsumed();
	}
	switch (verb) {
		case "list":
			return await handleListCommand(runtime);
		case "remove":
		case "rm":
			return await handleRemoveCommand(rest, runtime);
		case "add":
			return await handleAddCommand(rest, runtime);
		default:
			return usage(`Unknown /ssh subcommand: ${verb}. Use /ssh help for available subcommands.`, runtime);
	}
}
