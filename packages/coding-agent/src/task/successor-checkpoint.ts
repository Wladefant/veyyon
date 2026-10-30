import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import { type } from "@veyyon/ai/utils/schema/arktype";
import { atomicWriteJson } from "@veyyon/utils/atomic-write";
import { isEexist } from "@veyyon/utils/fs-error";
import type { AgentDefinition, SingleResult } from "./types";

const checkpointSchema = type({
	version: "2",
	sliceId: "string",
	agentId: "string",
	generation: "0 | 1 | 2",
	workflow: "string",
	results: type({ agentId: "string", output: "string", stderr: "string", "error?": "string" }).array(),
});

export type SuccessorCheckpoint = typeof checkpointSchema.infer;

/** Pin the selected task contract. A changed contract requires a new slice, not a silent migration. */
export function successorWorkflow(input: {
	agent: AgentDefinition;
	assignment: string;
	context: string | undefined;
	cwd: string;
	outputSchema: unknown;
}): string {
	return createHash("sha256")
		.update(
			JSON.stringify({
				// Description and source/file paths are discovery metadata, not the child's behavior.
				name: input.agent.name,
				systemPrompt: input.agent.systemPrompt,
				tools: input.agent.tools,
				spawns: input.agent.spawns,
				model: input.agent.model,
				thinkingLevel: input.agent.thinkingLevel,
				output: input.agent.output,
				blocking: input.agent.blocking,
				autoloadSkills: input.agent.autoloadSkills,
				contextVariant: input.agent.contextVariant,
				skillList: input.agent.skillList,
				readSummarize: input.agent.readSummarize,
				assignment: input.assignment,
				context: input.context,
				cwd: input.cwd,
				outputSchema: input.outputSchema,
			}),
		)
		.digest("hex");
}

/** Hash the ID rather than treating a caller-supplied predecessor ID as a filesystem path. */
function checkpointPath(directory: string, id: string): string {
	return path.join(directory, `${createHash("sha256").update(id).digest("hex")}.checkpoint.json`);
}

/**
 * One exclusive, permanent claim per checkpoint. A crash after claiming fails closed:
 * neither another process nor an invocation retry can start a second successor.
 * This is dispatch exclusion, not a transaction around the model's external actions.
 */
export async function claimSuccessorCheckpoint(
	directory: string,
	predecessorId: string,
	successorId: string,
	workflow: string,
): Promise<SuccessorCheckpoint> {
	const file = checkpointPath(directory, predecessorId);
	let checkpoint: SuccessorCheckpoint;
	try {
		const parsed = checkpointSchema(JSON.parse(await fs.readFile(file, "utf8")));
		if (parsed instanceof type.errors || parsed.agentId !== predecessorId) throw new Error("Invalid checkpoint");
		checkpoint = parsed;
	} catch {
		throw new Error(`successor-checkpoint-unavailable: no valid version 2 checkpoint for ${predecessorId}`);
	}
	if (checkpoint.generation >= 2) {
		throw new Error(`successor-limit: slice ${checkpoint.sliceId} already used its two successors`);
	}
	if (checkpoint.workflow !== workflow) {
		throw new Error(`successor-workflow-changed: ${predecessorId} requires its pinned task, agent contract and cwd`);
	}
	let claim: fs.FileHandle;
	try {
		claim = await fs.open(`${file}.claim`, "wx", 0o600);
	} catch (error) {
		if (isEexist(error)) {
			throw new Error(`successor-claimed: ${predecessorId} already has a successor claim; do not repeat its work`);
		}
		throw error;
	}
	try {
		await claim.writeFile(JSON.stringify({ predecessorId, successorId, sliceId: checkpoint.sliceId }));
		await claim.sync();
	} finally {
		await claim.close();
	}
	return checkpoint;
}

/** Save the settled lane's result before reporting it to the parent, using the existing crash-safe writer. */
export async function writeSuccessorCheckpoint(
	directory: string,
	result: SingleResult,
	workflow: string,
	predecessor?: SuccessorCheckpoint,
): Promise<void> {
	const checkpoint: SuccessorCheckpoint = {
		version: 2,
		sliceId: predecessor?.sliceId ?? result.id,
		agentId: result.id,
		generation: predecessor ? (predecessor.generation === 0 ? 1 : 2) : 0,
		workflow,
		results: [
			...(predecessor?.results ?? []),
			{
				agentId: result.id,
				output: result.output,
				stderr: result.stderr,
				error: result.error,
			},
		],
	};
	await atomicWriteJson(checkpointPath(directory, result.id), checkpoint);
}
