import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface ToolFailureIndexRow {
	schema_version: 1;
	tool: string;
	args_shape: Record<string, "string" | "number" | "boolean" | "bool" | "object" | "array" | "null">;
	error_text: string;

	session_id: string;
	file: string;
	line: number;
	timestamp: string;
	[key: string]: unknown;
}

export type ToolFailureRejectionReason =
	| "invalid-json"
	| "unsupported-version"
	| "missing-field"
	| "invalid-field";

export interface ToolFailureRejection {
	line: number;
	reason: ToolFailureRejectionReason;
}

export interface ParsedToolFailureIndex {
	records: ToolFailureIndexRow[];
	rejections: ToolFailureRejection[];
}

export interface ToolFailureDigest {
	schema_version: 1;
	tool_case_count: number;
	coverage_complete: boolean;
}

export interface LoadedToolFailureIndex extends ParsedToolFailureIndex {
	day: string;
	digest: ToolFailureDigest;
}

const requiredFields = [
	"schema_version",
	"tool",
	"args_shape",
	"error_text",
	"session_id",
	"file",
	"line",
	"timestamp",
] as const;

const shapeTypes = new Set(["string", "number", "boolean", "bool", "object", "array", "null"]);
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;

function validDay(value: string): boolean {
	if (!dayPattern.test(value)) return false;
	const date = new Date(`${value}T00:00:00.000Z`);
	return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function validTimestamp(value: string): boolean {
	if (!timestampPattern.test(value) || !validDay(value.slice(0, 10))) return false;
	const time = value.slice(11, 19).split(":").map(Number);
	return time[0] <= 23 && time[1] <= 59 && time[2] <= 59 && Number.isFinite(Date.parse(value));
}

function safeRelativeFile(value: string): boolean {
	if (value.length === 0 || value.includes("\\") || value.includes("\0") || value.includes(":") || value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
		return false;
	}
	return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function validRow(value: unknown): value is ToolFailureIndexRow {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
	const row = value as Record<string, unknown>;
	if (row.schema_version !== 1) return false;
	if (
		typeof row.tool !== "string" || row.tool.trim().length === 0 ||
		typeof row.error_text !== "string" || row.error_text.trim().length === 0 ||
		typeof row.session_id !== "string" || row.session_id.trim().length === 0 ||
		typeof row.file !== "string" || !safeRelativeFile(row.file) ||
		!Number.isSafeInteger(row.line) || (row.line as number) < 1 ||
		typeof row.timestamp !== "string" || !validTimestamp(row.timestamp)
	) return false;
	if (typeof row.args_shape !== "object" || row.args_shape === null || Array.isArray(row.args_shape)) return false;
	return Object.values(row.args_shape).every((shape) => typeof shape === "string" && shapeTypes.has(shape));
}

export function parseToolFailureIndex(text: string): ParsedToolFailureIndex {
	const records: ToolFailureIndexRow[] = [];
	const rejections: ToolFailureRejection[] = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index++) {
		const source = lines[index];
		if (source.trim().length === 0) continue;
		let value: unknown;
		try {
			value = JSON.parse(source);
		} catch {
			rejections.push({ line: index + 1, reason: "invalid-json" });
			continue;
		}
		if (typeof value === "object" && value !== null && !Array.isArray(value)) {
			const candidate = value as Record<string, unknown>;
			if (Object.hasOwn(candidate, "schema_version") && candidate.schema_version !== 1) {
				rejections.push({ line: index + 1, reason: "unsupported-version" });
				continue;
			}
			if (requiredFields.some((field) => !Object.hasOwn(candidate, field))) {
				rejections.push({ line: index + 1, reason: "missing-field" });
				continue;
			}
		}
		if (!validRow(value)) {
			rejections.push({ line: index + 1, reason: "invalid-field" });
			continue;
		}
		records.push(value);
	}
	return { records, rejections };
}


export async function loadNewestToolFailureIndex(root: string): Promise<LoadedToolFailureIndex> {
	const entries = await fs.readdir(root, { withFileTypes: true });
	const days = entries
		.filter((entry) => entry.isDirectory() && validDay(entry.name))
		.map((entry) => entry.name)
		.sort();
	const day = days.at(-1);
	if (!day) throw new Error("tool-failure index has no YYYY-MM-DD directory");

	const directory = path.join(root, day);
	const [indexText, digestText] = await Promise.all([
		fs.readFile(path.join(directory, "tool-errors.jsonl"), "utf8"),
		fs.readFile(path.join(directory, "digest.json"), "utf8"),
	]);
	let digestValue: unknown;
	try {
		digestValue = JSON.parse(digestText);
	} catch {
		throw new Error(`invalid digest.json in ${day}`);
	}
	if (typeof digestValue !== "object" || digestValue === null || Array.isArray(digestValue)) {
		throw new Error(`invalid digest.json in ${day}`);
	}
	const digest = digestValue as Record<string, unknown>;
	if (
		digest.schema_version !== 1 || !Number.isSafeInteger(digest.tool_case_count) ||
		(digest.tool_case_count as number) < 0 || typeof digest.coverage_complete !== "boolean"
	) throw new Error(`invalid digest.json in ${day}`);

	const parsed = parseToolFailureIndex(indexText);
	const toolCaseCount = indexText.split(/\r?\n/).filter((line) => line.trim().length > 0).length;
	if (digest.tool_case_count !== toolCaseCount) {
		throw new Error(`tool-failure index count does not match digest.json in ${day}`);
	}
	return {
		day,
		digest: {
			schema_version: 1,
			tool_case_count: digest.tool_case_count as number,
			coverage_complete: digest.coverage_complete,
		},
		...parsed,
	};
}
