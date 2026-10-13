import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { CheckpointClient } from "../checkpoints/cloud-checkpoints";
import { captureNativeCheckpoint, forkNativeCheckpoint, restoreNativeCheckpoint } from "../checkpoints/native-recovery";
import { settings } from "../config/settings";

export interface CheckpointCommandArgs {
	action: "status" | "restore" | "fork" | "export" | "handoff";
	id?: string;
	output?: string;
	sessionFile?: string;
	workspace?: string[];
	targetNode?: string;
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
	if (args.action === "export" || args.action === "handoff") {
		if (!args.sessionFile) throw new Error(`Checkpoint ${args.action} requires --file <session.jsonl>`);
		if (args.action === "handoff" && !args.targetNode)
			throw new Error("Session handoff requires --to <destination node>");
		if (args.action === "handoff" && !process.env.VEYYON_CHECKPOINT_NODE)
			throw new Error("Session handoff requires VEYYON_CHECKPOINT_NODE to match the source runtime owner");
		const bundle = await captureNativeCheckpoint(args.sessionFile, args.workspace ?? []);
		if (args.action === "handoff" && args.id && args.id !== bundle.native.sessionId)
			throw new Error("The requested session id does not match the source file");
		const sessionId = bundle.native.sessionId;
		const ownerNode =
			args.action === "handoff" ? process.env.VEYYON_CHECKPOINT_NODE! : process.env.VEYYON_CHECKPOINT_NODE || randomUUID();
		const lease = await client.acquireLease(sessionId, ownerNode);
		let transferred = false;
		let committed = false;
		try {
			const head = await client.head(sessionId);
			await client.commit(sessionId, bundle, head?.sequence ?? lease.headSequence);
			committed = true;
			if (args.action === "handoff") {
				const next = await client.transferLease(sessionId, args.targetNode!);
				transferred = true;
				console.log(JSON.stringify({ sessionId, transferred: true, ownerNode: next.ownerNode, epoch: next.epoch }));
			} else {
				console.log(JSON.stringify({ sessionId, exported: true }));
			}
		} finally {
			if (!transferred && (!committed || args.action !== "handoff")) await client.releaseLease(sessionId);
		}
		return;
	}
	if (!args.id) throw new Error("A session id is required");
	if (args.action === "status") {
		console.log(JSON.stringify(await client.head(args.id)));
		return;
	}
	if (args.action === "fork") {
		const bundle = await client.restore(args.id);
		if (!bundle) throw new Error(`No checkpoint exists for session ${args.id}`);
		console.log(JSON.stringify(await forkNativeCheckpoint(bundle)));
		return;
	}
	if (!args.output) throw new Error("Restore requires --output <new directory>");
	const ownerNode = process.env.VEYYON_CHECKPOINT_NODE || randomUUID();
	await client.acquireLease(args.id, ownerNode);
	let restored = false;
	try {
		const bundle = await client.restore(args.id);
		if (!bundle) throw new Error(`No checkpoint exists for session ${args.id}`);
		const id = await restoreNativeCheckpoint(bundle, resolve(args.output));
		restored = true;
		console.log(`Restored native session ${id} to ${resolve(args.output)}; runtime owner ${ownerNode}`);
	} finally {
		if (!restored) await client.releaseLease(args.id);
	}
}
