import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CheckpointClient } from "../checkpoints/cloud-checkpoints";
import { captureNativeCheckpoint, forkNativeCheckpoint, restoreNativeCheckpoint } from "../checkpoints/native-recovery";
import { settings } from "../config/settings";

export interface CheckpointCommandArgs {
	action: "status" | "restore" | "fork" | "export";
	id?: string;
	output?: string;
	sessionFile?: string;
	workspace?: string[];
}
export async function runCheckpointCommand(args: CheckpointCommandArgs): Promise<void> {
	if (args.action === "fork" && args.sessionFile) {
		const bundle = await captureNativeCheckpoint(args.sessionFile, args.workspace ?? []);
		console.log(JSON.stringify(await forkNativeCheckpoint(bundle)));
		return;
	}
	if (!settings.get("checkpoints.enabled"))
		throw new Error("Cloud checkpoints are disabled. Enable checkpoints.enabled to use this command.");
	const client = CheckpointClient.fromEnv();
	if (!client.enabled) throw new Error("Cloud checkpoint URL, bearer token, and encryption key must be configured.");
	if (args.action === "export") {
		if (!args.sessionFile) throw new Error("Checkpoint export requires --file <session.jsonl>");
		const bundle = await captureNativeCheckpoint(args.sessionFile, args.workspace ?? []);
		const sessionId = bundle.native.sessionId;
		const lease = await client.acquireLease(sessionId, randomUUID());
		try {
			const head = await client.head(sessionId);
			await client.commit(sessionId, bundle, head?.sequence ?? lease.headSequence);
		} finally {
			await client.releaseLease(sessionId);
		}
		console.log(JSON.stringify({ sessionId, exported: true }));
		return;
	}
	if (!args.id) throw new Error("A session id is required");
	if (args.action === "status") {
		console.log(JSON.stringify(await client.head(args.id)));
		return;
	}
	const bundle = await client.restore(args.id);
	if (!bundle) throw new Error(`No checkpoint exists for session ${args.id}`);
	if (args.action === "fork") {
		console.log(JSON.stringify(await forkNativeCheckpoint(bundle)));
		return;
	}
	if (!args.output) throw new Error("Restore requires --output <new directory>");
	await client.acquireLease(args.id, randomUUID());
	try {
		const id = await restoreNativeCheckpoint(bundle, resolve(args.output));
		console.log(`Restored native session ${id} to ${resolve(args.output)}`);
	} finally {
		await client.releaseLease(args.id);
	}
}
