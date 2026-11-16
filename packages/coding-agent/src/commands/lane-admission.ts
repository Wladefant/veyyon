/**
 * CLI command for host-wide shared lane admission (`veyyon lane-admission`).
 *
 * Uses subpath imports only to stay lightweight for external callers such as
 * Python `WorkerBackend` (`blocker_dispatch.py`).
 */
import { Args, Command, Flags } from "@veyyon/utils/cli";
import { errorMessage } from "@veyyon/utils/type-guards";
import {
	acquireLaneAdmission,
	adoptLaneAdmission,
	getLaneAdmissionStatus,
	heartbeatLaneAdmission,
	LaneAdmissionError,
	type LaneAdmissionKind,
	releaseLaneAdmission,
	setLaneAdmissionCap,
} from "../task/lane-admission";

const ACTIONS = ["status", "acquire", "adopt", "heartbeat", "release", "set-cap"] as const;

export default class LaneAdmissionCommand extends Command {
	static description = "Manage host-wide shared lane admission slots";

	static args = {
		action: Args.string({
			description: "Admission action (status, acquire, adopt, heartbeat, release, set-cap)",
			required: true,
			options: [...ACTIONS],
		}),
	};

	static flags = {
		owner: Flags.string({ description: "Owner / dispatch identifier (for acquire)" }),
		kind: Flags.string({
			description: "Reservation kind (external or native)",
			options: ["external", "native"],
			default: "external",
		}),
		pid: Flags.integer({ description: "PID (caller PID on acquire, or worker PID on adopt)" }),
		"worker-pid": Flags.integer({ description: "Spawned worker PID to bind immediately on acquire" }),
		"slot-id": Flags.string({ description: "Reservation slot ID (for adopt, heartbeat, release)" }),
		"lease-token": Flags.string({ description: "Fencing lease token (for adopt, heartbeat, release)" }),
		cap: Flags.integer({ description: "Per-call ceiling, or persisted host policy for set-cap (1..100)" }),
		json: Flags.boolean({ description: "Emit machine-readable JSON", default: false }),
	};

	static examples = [
		"veyyon lane-admission status --json",
		"veyyon lane-admission acquire --owner disp-123 --kind external --json",
		"veyyon lane-admission adopt --slot-id <uuid> --lease-token <uuid> --pid 12345 --json",
		"veyyon lane-admission heartbeat --slot-id <uuid> --lease-token <uuid> --json",
		"veyyon lane-admission release --slot-id <uuid> --lease-token <uuid> --json",
		"veyyon lane-admission set-cap --cap 100 --json",
	];

	private emit(payload: unknown, asJson: boolean): void {
		if (asJson) {
			process.stdout.write(`${JSON.stringify(payload)}\n`);
			return;
		}
		process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
	}

	private fail(action: string, reason: string, message: string, asJson: boolean): void {
		if (asJson) {
			this.emit({ ok: false, action, reason, error: message }, true);
		} else {
			process.stderr.write(`Error (${reason}): ${message}\n`);
		}
		process.exitCode = 1;
	}

	async run(): Promise<void> {
		const { args, flags } = await this.parse(LaneAdmissionCommand);
		const action = typeof args.action === "string" ? args.action : "";
		const asJson = Boolean(flags.json);

		try {
			switch (action) {
				case "status": {
					const result = await getLaneAdmissionStatus({ cap: flags.cap });
					this.emit(result, asJson);
					return;
				}
				case "acquire": {
					if (!flags.owner || flags.owner.trim().length === 0) {
						this.fail(action, "missing_owner", "Missing required --owner for acquire", asJson);
						return;
					}
					const kind = (flags.kind === "native" ? "native" : "external") as LaneAdmissionKind;
					const result = await acquireLaneAdmission({
						owner: flags.owner,
						kind,
						callerPid: flags.pid ?? null,
						workerPid: flags["worker-pid"],
						cap: flags.cap,
					});
					this.emit(result, asJson);
					if (!result.admitted) process.exitCode = 1;
					return;
				}
				case "adopt": {
					if (!flags["slot-id"] || !flags["lease-token"] || flags.pid === undefined) {
						this.fail(
							action,
							"missing_arguments",
							"adopt requires --slot-id, --lease-token, and --pid",
							asJson,
						);
						return;
					}
					const result = await adoptLaneAdmission({
						slotId: flags["slot-id"],
						leaseToken: flags["lease-token"],
						pid: flags.pid,
					});
					this.emit(result, asJson);
					if (!result.ok) process.exitCode = 1;
					return;
				}
				case "heartbeat": {
					if (!flags["slot-id"] || !flags["lease-token"]) {
						this.fail(
							action,
							"missing_arguments",
							"heartbeat requires --slot-id and --lease-token",
							asJson,
						);
						return;
					}
					const result = await heartbeatLaneAdmission({
						slotId: flags["slot-id"],
						leaseToken: flags["lease-token"],
					});
					this.emit(result, asJson);
					if (!result.ok) process.exitCode = 1;
					return;
				}
				case "release": {
					if (!flags["slot-id"] || !flags["lease-token"]) {
						this.fail(
							action,
							"missing_arguments",
							"release requires --slot-id and --lease-token",
							asJson,
						);
						return;
					}
					const result = await releaseLaneAdmission({
						slotId: flags["slot-id"],
						leaseToken: flags["lease-token"],
						cap: flags.cap,
					});
					this.emit(result, asJson);
					if (!result.ok) process.exitCode = 1;
					return;
				}
				case "set-cap": {
					if (flags.cap === undefined) {
						this.fail(action, "missing_arguments", "set-cap requires --cap", asJson);
						return;
					}
					await setLaneAdmissionCap({ cap: flags.cap });
					this.emit({ ok: true, action, cap: flags.cap }, asJson);
					return;
				}
				default:
					this.fail(action, "unknown_action", `Unknown action: ${action}`, asJson);
			}
		} catch (error) {
			const code = error instanceof LaneAdmissionError ? error.code : "lane_admission_error";
			this.fail(action, code, errorMessage(error), asJson);
		}
	}
}
