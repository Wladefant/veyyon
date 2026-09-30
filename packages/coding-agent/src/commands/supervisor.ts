import { Args, Command, Flags, renderCommandHelp } from "@veyyon/utils/cli";
import {
	DEFAULT_DUMP_COUNT,
	DEFAULT_DUMP_FOLDER,
	disableLocalDumps,
	enableLocalDumps,
	MAX_DUMP_COUNT,
	MIN_DUMP_COUNT,
	statusLocalDumps,
} from "../supervisor/dumps";

export default class Supervisor extends Command {
	static description = "Manage process supervisor and Windows crash dump diagnostics";

	static args = {
		subsystem: Args.string({
			description: "Target subsystem (dumps)",
			required: false,
			options: ["dumps"],
		}),
		action: Args.string({
			description: "Action to perform (enable, disable, status)",
			required: false,
			options: ["enable", "disable", "status"],
		}),
	};

	static flags = {
		count: Flags.integer({
			description: `Maximum crash dumps to retain (default: ${DEFAULT_DUMP_COUNT}, bounded: ${MIN_DUMP_COUNT}-${MAX_DUMP_COUNT})`,
		}),
		folder: Flags.string({
			description: `Dump directory path (default: ${DEFAULT_DUMP_FOLDER})`,
		}),
		json: Flags.boolean({
			description: "Output JSON",
		}),
	};

	static examples = [
		"# Check whether veyyon.exe and bun.exe are configured for LocalDumps (HKCU)\n  veyyon supervisor dumps status",
		"# Opt in to Windows LocalDumps collection for veyyon.exe and bun.exe (disabled by default)\n  veyyon supervisor dumps enable",
		"# Enable with custom dump directory and retention count (1-100, Type 1 Mini dump)\n  veyyon supervisor dumps enable --folder C:\\CrashDumps --count 10",
		"# Disable LocalDumps collection and revert registry configuration (removes only veyyon.exe and bun.exe keys under HKCU)\n  veyyon supervisor dumps disable",
		"# Output status in JSON format\n  veyyon supervisor dumps status --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Supervisor);

		if (args.subsystem !== "dumps" || !args.action || !["enable", "disable", "status"].includes(args.action)) {
			renderCommandHelp("veyyon", "supervisor", Supervisor);
			return;
		}

		if (args.action === "status") {
			const res = await statusLocalDumps();
			if (flags.json) {
				process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
				return;
			}
			if (!res.supported) {
				process.stdout.write(`Windows LocalDumps is unsupported on ${process.platform}.\n`);
				return;
			}
			process.stdout.write("Windows LocalDumps status (HKCU):\n");
			for (const [app, info] of Object.entries(res.apps ?? {})) {
				if (info.configured) {
					process.stdout.write(
						`  ${app}: configured (DumpFolder: ${info.folder}, DumpCount: ${info.count}, DumpType: ${info.type} [Mini dump])\n`,
					);
				} else {
					process.stdout.write(`  ${app}: unconfigured\n`);
				}
			}
			return;
		}

		const res =
			args.action === "enable"
				? await enableLocalDumps({ count: flags.count, folder: flags.folder })
				: await disableLocalDumps();

		if (flags.json) {
			process.stdout.write(`${JSON.stringify(res, null, 2)}\n`);
			return;
		}
		if (!res.supported) {
			process.stdout.write(`Windows LocalDumps is unsupported on ${process.platform}.\n`);
			return;
		}
		process.stdout.write(`${res.message}\n`);
	}
}
