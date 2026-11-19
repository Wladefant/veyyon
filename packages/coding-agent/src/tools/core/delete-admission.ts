import type { BeforeToolCallContext, BeforeToolCallResult } from "@veyyon/agent-core";
import { Patch } from "@veyyon/hashline";
import { isRecord } from "@veyyon/utils";
import { parseApplyPatch } from "../../edit/apply-patch/parser";
import { findShellDelete } from "../shell/bash-guard";
import { TOOL } from "./builtin-names";

const DELETE_REFUSAL = "File deletion is blocked for Gemini 4 Hydrogen. Report the path to your parent.";
const DELEGATION_REFUSAL = "Gemini 4 Hydrogen cannot delegate to an agent without the same delete restriction. Ask your parent to delegate.";

function removesPatchedPath(op: unknown): boolean {
	return isRecord(op) && (op.op === "delete" || typeof op.rename === "string");
}

function removesEditedPath(args: Record<string, unknown>, cwd: string, applyPatch: boolean): boolean {
	if (Array.isArray(args.edits)) return args.edits.some(removesPatchedPath);
	if (typeof args.input !== "string") return false;
	if (applyPatch || args.input.includes("*** Begin Patch")) {
		return parseApplyPatch(args.input).some(removesPatchedPath);
	}
	return Patch.parse(args.input, { cwd }).sections.some(section => section.fileOp !== undefined);
}

function shellDeletes(command: string, env: unknown): boolean {
	const effectiveEnv = { ...process.env };
	if (isRecord(env)) {
		for (const [name, value] of Object.entries(env)) {
			if (typeof value === "string") effectiveEnv[name] = value;
		}
	}
	return findShellDelete(command, effectiveEnv) !== undefined;
}

/** Hard refusal before dispatch. Shell inspection covers known forms, not arbitrary scripts. */
export function checkDeleteAdmission(
	{ assistantMessage, toolCall, args }: BeforeToolCallContext,
	cwd: string,
): BeforeToolCallResult | undefined {
	if (
		assistantMessage.provider !== "google-antigravity" ||
		!assistantMessage.model.startsWith("gemini-4-hydrogen-")
	) {
		return undefined;
	}
	let removes = false;
	switch (toolCall.name) {
		case TOOL.bash:
			removes = typeof args.command === "string" && shellDeletes(args.command, args.env);
			break;
		case TOOL.launch:
			if (args.op === "start" && typeof args.application === "string") {
				const argv: unknown[] = Array.isArray(args.args) ? args.args : [];
				const command = [args.application, ...argv.filter(arg => typeof arg === "string")]
					.map(word => JSON.stringify(word))
					.join(" ");
				removes = shellDeletes(command, args.env);
			}
			break;
		case TOOL.edit:
		case "apply_patch":
			removes = removesEditedPath(args, cwd, toolCall.name === "apply_patch");
			break;
		case TOOL.write:
			removes = typeof args.content === "string" && args.content.trim() === "";
			break;
		case TOOL.ast_edit:
			removes =
				Array.isArray(args.ops) &&
				args.ops.some(op => isRecord(op) && typeof op.out === "string" && op.out.trim() === "");
			break;
		case TOOL.rewind:
			removes = true;
			break;
		case TOOL.task:
			return { block: true, reason: DELEGATION_REFUSAL };
	}
	return removes ? { block: true, reason: DELETE_REFUSAL } : undefined;
}
