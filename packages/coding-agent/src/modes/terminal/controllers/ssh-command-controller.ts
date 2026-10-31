/**
 * SSH Command Controller
 *
 * Handles /ssh subcommands for managing SSH host configurations.
 */
import { errorMessage, getProjectDir, getSSHConfigPath, logger } from "@veyyon/utils";
import { loadCapability } from "../../../discovery";
import { type SSHHost, sshCapability } from "../../../discovery/capability/ssh";
import { parseSshAddArgs, parseSshRemoveArgs, SSH_ADD_USAGE } from "../../../slash-commands/helpers/ssh-args";
import { addSSHHost, readSSHConfigFile, removeSSHHost } from "../../../ssh/config-writer";
import { theme } from "../../../theme/theme-binding";
import type { InteractiveModeContext } from "../types";
import { dispatchSubcommand, groupBySource, showCommandMessage } from "./command-controller-shared";

/**
 * The slice of the interactive context this controller uses: 2 members of the
 * 215 `InteractiveModeContext` requires. Naming the slice keeps the dependency
 * legible and lets a test build one without the `as unknown as
 * InteractiveModeContext` cast the full interface forces (see
 * `CollabHostContext`).
 */
export type SshCommandControllerContext = Pick<InteractiveModeContext, "present" | "session" | "showError">;

export class SSHCommandController {
	constructor(private ctx: SshCommandControllerContext) {}

	/** `/ssh <subcommand>`. `args` is the text after `/ssh`, as the slash dispatcher parsed it. */
	async handle(args: string): Promise<void> {
		await dispatchSubcommand(
			args,
			"ssh",
			[
				{ name: "add", handler: rest => this.#handleAdd(rest) },
				{ name: "list", handler: () => this.#handleList() },
				{ name: "remove", aliases: ["rm"], handler: rest => this.#handleRemove(rest) },
			],
			{
				onHelp: () => this.#showHelp(),
				showError: msg => this.ctx.showError(msg),
			},
		);
	}

	/**
	 * Show help text
	 */
	#showHelp(): void {
		const helpText = [
			"",
			theme.bold("SSH Host Management"),
			"",
			"Manage SSH host configurations for remote command execution.",
			"",
			theme.fg("accent", "Commands:"),
			`  ${SSH_ADD_USAGE.replace("Usage: ", "")}`,
			"  /ssh list             List all configured SSH hosts",
			"  /ssh remove <name>    Remove an SSH host",
			"  /ssh help             Show this help message",
			"",
		].join("\n");

		this.#showMessage(helpText);
	}

	/**
	 * Handle /ssh add - read the plain-word arguments and add the host to config
	 */
	async #handleAdd(rest: string): Promise<void> {
		const request = parseSshAddArgs(rest);
		if ("error" in request) {
			this.ctx.showError(request.error);
			return;
		}
		const { name, config } = request;
		try {
			await addSSHHost(getSSHConfigPath(), name, config);
			await this.ctx.session.refreshSshTool({ activateIfAvailable: true });

			const lines = ["", theme.fg("success", `+ Added SSH host "${name}"`), "", `  Host: ${config.host}`];
			if (config.username) lines.push(`  User: ${config.username}`);
			if (config.port) lines.push(`  Port: ${config.port}`);
			if (config.keyPath) lines.push(`  Key:  ${config.keyPath}`);
			if (config.description) lines.push(`  Desc: ${config.description}`);
			if (config.compat) lines.push(`  Compat: true`);
			lines.push("");
			lines.push(theme.fg("muted", `Run ${theme.fg("accent", "/ssh list")} to see all configured hosts.`));
			lines.push("");

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			const errorMsg = errorMessage(error);

			let helpText = "";
			if (errorMsg.includes("already exists")) {
				helpText = `\n\nTip: Use ${theme.fg("accent", "/ssh remove")} first, or choose a different name.`;
			}

			this.ctx.showError(`Failed to add host: ${errorMsg}${helpText}`);
		}
	}

	/**
	 * Handle /ssh list - show all configured SSH hosts
	 */
	async #handleList(): Promise<void> {
		try {
			const cwd = getProjectDir();
			const userConfig = await readSSHConfigFile(getSSHConfigPath());
			const userHosts = Object.keys(userConfig.hosts ?? {});

			// Load discovered hosts via capability system
			const configHostNames = new Set(userHosts);
			let discoveredHosts: SSHHost[] = [];
			try {
				const result = await loadCapability<SSHHost>(sshCapability.id, { cwd });
				discoveredHosts = result.items.filter(h => !configHostNames.has(h.name));
			} catch (error) {
				// Configured hosts still list, but the user should know why
				// discovered hosts are missing instead of seeing a short list.
				logger.warn("SSH host discovery failed; listing configured hosts only", {
					error: errorMessage(error),
				});
			}

			if (userHosts.length === 0 && discoveredHosts.length === 0) {
				this.#showMessage(
					[
						"",
						theme.fg("muted", "No SSH hosts configured."),
						"",
						`Use ${theme.fg("accent", "/ssh add")} to add a host.`,
						"",
					].join("\n"),
				);
				return;
			}

			const lines: string[] = ["", theme.bold("Configured SSH Hosts"), ""];

			// Hosts configured in the active profile
			if (userHosts.length > 0) {
				lines.push(theme.fg("accent", "Profile level") + theme.fg("muted", " (ssh.json):"));
				for (const name of userHosts) {
					const config = userConfig.hosts![name];
					const details = formatHostDetails(config);
					lines.push(`  ${theme.fg("accent", name)} ${details}`);
				}
				lines.push("");
			}

			// Read-only hosts contributed by a discovery provider
			if (discoveredHosts.length > 0) {
				for (const { providerName, shortPath, items: hosts } of groupBySource(discoveredHosts, h => h._source)) {
					lines.push(
						theme.fg("accent", "Discovered") +
							theme.fg("muted", ` (${providerName}: ${shortPath}):`) +
							theme.fg("dim", " read-only"),
					);
					for (const host of hosts) {
						const details = formatHostDetails({
							host: host.host,
							username: host.username,
							port: host.port,
						});
						lines.push(`  ${theme.fg("accent", host.name)} ${details}`);
					}
					lines.push("");
				}
			}

			this.#showMessage(lines.join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to list hosts: ${errorMessage(error)}`);
		}
	}

	/**
	 * Handle /ssh remove <name> - remove a host from config
	 */
	async #handleRemove(rest: string): Promise<void> {
		const request = parseSshRemoveArgs(rest);
		if ("error" in request) {
			this.ctx.showError(request.error);
			return;
		}
		const { name } = request;

		try {
			const filePath = getSSHConfigPath();
			const config = await readSSHConfigFile(filePath);
			if (!config.hosts?.[name]) {
				this.ctx.showError(`Host "${name}" not found.`);
				return;
			}

			await removeSSHHost(filePath, name);
			await this.ctx.session.refreshSshTool();

			this.#showMessage(["", theme.fg("success", `- Removed SSH host "${name}"`), ""].join("\n"));
		} catch (error) {
			this.ctx.showError(`Failed to remove host: ${errorMessage(error)}`);
		}
	}

	/**
	 * Show a message in the chat
	 */
	#showMessage(text: string): void {
		showCommandMessage(this.ctx, text);
	}
}

/**
 * Format host details (host, user, port) for display
 */
function formatHostDetails(config: { host?: string; username?: string; port?: number }): string {
	const parts: string[] = [];
	if (config.host) parts.push(config.host);
	if (config.username) parts.push(`user=${config.username}`);
	if (config.port && config.port !== 22) parts.push(`port=${config.port}`);
	return theme.fg("dim", parts.length > 0 ? `[${parts.join(", ")}]` : "");
}
