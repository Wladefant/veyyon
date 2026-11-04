import type { ExtensionAPI } from "@veyyon/coding-agent";
import { bridgeRequest, MainplaneError, visibleError, WORKER_ID } from "./mainplane-bridge-wire";

export const MAINPLANE_UPSTREAM_SOURCE = "123c20654133782cc0a5e0a3c9edfa5410b09f6e";
const METADATA = /^[\x20-\x7e]{0,64}$/;
export interface FleetWorker {
	name: string;
	status: "connected" | "refused";
	os: string;
	arch: string;
	version: string;
	interpreters: string[];
}
export interface FleetInventory {
	schema_version: 1;
	adapter: "superboard-mainplane-bridge/v2";
	upstream_source_sha: string;
	scope: "connected-or-refused";
	workers: FleetWorker[];
}

export function validateFleetInventory(data: Record<string, unknown>): FleetInventory {
	if (data.schema_version !== 1 || data.adapter !== "superboard-mainplane-bridge/v2" ||
		data.upstream_source_sha !== MAINPLANE_UPSTREAM_SOURCE || data.scope !== "connected-or-refused" ||
		!Array.isArray(data.workers) || data.workers.length > 1024) {
		throw new MainplaneError("Mainplane fleet schema/source is unsupported");
	}
	const names = new Set<string>();
	const workers: FleetWorker[] = [];
	for (const value of data.workers) {
		if (!value || typeof value !== "object" || Array.isArray(value)) throw new MainplaneError("Invalid Mainplane worker inventory");
		const row = value as Record<string, unknown>;
		if (typeof row.name !== "string" || !WORKER_ID.test(row.name) || names.has(row.name) ||
			(row.status !== "connected" && row.status !== "refused") ||
			typeof row.os !== "string" || !METADATA.test(row.os) || typeof row.arch !== "string" || !METADATA.test(row.arch) ||
			typeof row.version !== "string" || !METADATA.test(row.version) ||
			!Array.isArray(row.interpreters) || row.interpreters.length > 16) {
			throw new MainplaneError("Invalid or duplicate Mainplane worker inventory");
		}
		names.add(row.name);
		const interpreters: string[] = [];
		for (const interpreter of row.interpreters) {
			if (typeof interpreter !== "string" || !WORKER_ID.test(interpreter) || interpreters.includes(interpreter)) {
				throw new MainplaneError("Invalid Mainplane interpreter inventory");
			}
			interpreters.push(interpreter);
		}
		workers.push({ name: row.name, status: row.status, os: row.os, arch: row.arch, version: row.version,
			interpreters: interpreters.sort() });
	}
	workers.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
	return { schema_version: 1, adapter: "superboard-mainplane-bridge/v2", upstream_source_sha: MAINPLANE_UPSTREAM_SOURCE,
		scope: "connected-or-refused", workers };
}

export async function discoverFleet(origin: string, token: string, signal?: AbortSignal, transport: typeof fetch = fetch): Promise<FleetInventory> {
	const { data } = await bridgeRequest(origin, token, { path: "/fleet/workers", method: "GET", responseLimit: 512 * 1024 }, signal, transport);
	return validateFleetInventory(data);
}

export function registerMainplaneDiscovery(pi: ExtensionAPI): void {
	const { z } = pi.zod;
	pi.registerTool({
		name: "mainplane_fleet_status",
		label: "Mainplane connected worker inventory",
		description: "Read actual connected/refused owner-fleet workers and interpreter names. Missing workers may be offline, not unenrolled. Discovery does not reserve or execute work.",
		parameters: z.object({}).strict(),
		async execute(_toolCallId, _params, signal) {
			try {
				const inventory = await discoverFleet(process.env.MAINPLANE_BRIDGE_URL ?? "", process.env.MAINPLANE_API_KEY ?? "", signal);
				return { content: [{ type: "text", text: JSON.stringify(inventory) }],
					details: { connected: inventory.workers.filter(worker => worker.status === "connected").length,
						refused: inventory.workers.filter(worker => worker.status === "refused").length } };
			} catch (error) {
				return { content: [{ type: "text", text: visibleError(error) }], isError: true };
			}
		},
	});
}
