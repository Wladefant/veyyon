import { readFile, writeFile, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MAX_SHARDS = 255;
export const DEFAULT_TARGET_MS = 480000;

function validPath(file) {
	return typeof file === "string" && file.length > 0 && !file.includes("\\") &&
		!file.startsWith("/") && !/^[A-Za-z]:/.test(file) &&
		file.split("/").every(part => part !== "" && part !== "." && part !== "..") &&
		!/[\0\r\n]/.test(file);
}

/** Pure deterministic LPT planner. Input paths and durations are repository-relative. */
export function planShards(files, durations, targetMs = DEFAULT_TARGET_MS, unknownDurationMs = 449) {
	if (!Array.isArray(files)) throw new TypeError("files must be an array");
	if (!durations || typeof durations !== "object" || Array.isArray(durations)) throw new TypeError("durations must be a map");
	if (typeof targetMs !== "number" || !Number.isFinite(targetMs) || targetMs <= 0) throw new RangeError("targetMs must be a positive finite number");
	if (typeof unknownDurationMs !== "number" || !Number.isFinite(unknownDurationMs) || unknownDurationMs < 0) throw new RangeError("unknownDurationMs must be a non-negative finite number");
	const seen = new Set();
	for (const file of files) {
		if (!validPath(file)) throw new TypeError(`invalid selected path: ${String(file)}`);
		if (seen.has(file)) throw new Error(`duplicate selected path: ${file}`);
		seen.add(file);
	}
	const entries = files.map(file => {
		const duration = Object.hasOwn(durations, file) ? durations[file] : unknownDurationMs;
		if (typeof duration !== "number" || !Number.isFinite(duration) || duration < 0) {
			throw new TypeError(`invalid duration for ${file}`);
		}
		return { file, duration };
	});
	const totalDurationMs = entries.reduce((sum, entry) => sum + entry.duration, 0);
	if (!Number.isFinite(totalDurationMs)) throw new RangeError("total duration must be finite");
	const shardCount = Math.max(1, Math.ceil(totalDurationMs / targetMs));
	if (shardCount > MAX_SHARDS) throw new RangeError(`required shard count ${shardCount} exceeds limit ${MAX_SHARDS}`);
	const shards = Array.from({ length: shardCount }, (_, index) => ({ index, durationMs: 0, files: [] }));
	entries.sort((a, b) => b.duration - a.duration || a.file.localeCompare(b.file, "en"));
	for (const entry of entries) {
		let least = 0;
		for (let index = 1; index < shards.length; index++) {
			if (shards[index].durationMs < shards[least].durationMs) least = index;
		}
		shards[least].files.push(entry.file);
		shards[least].durationMs += entry.duration;
	}
	for (const shard of shards) shard.files.sort((a, b) => a.localeCompare(b, "en"));
	const assigned = shards.flatMap(shard => shard.files);
	if (assigned.length !== files.length || new Set(assigned).size !== seen.size || assigned.some(file => !seen.has(file))) {
		throw new Error("internal planner error: selected files were not assigned exactly once");
	}
	return { targetDurationMs: targetMs, shardCount, shards };
}

export function parseSelectedLines(text) {
	if (typeof text !== "string") throw new TypeError("selected-lines input must be text");
	const lines = text.replace(/\r\n/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	if (lines.some(line => line.trim() === "")) throw new Error("selected-lines input contains an empty path");
	return lines;
}

async function atomicWrite(file, content) {
	const temp = `${file}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
	try {
		await writeFile(temp, content, { flag: "wx" });
		await rename(temp, file);
	} catch (error) {
		await rm(temp, { force: true }).catch(() => {});
		throw error;
	}
}

export async function runCli(args = process.argv.slice(2), env = process.env) {
	let input, output;
	for (let i = 0; i < args.length; i++) {
		if (args[i] === "--input" && input === undefined) input = args[++i];
		else if (args[i] === "--output" && output === undefined) output = args[++i];
		else throw new Error(`unexpected or duplicate argument: ${args[i]}`);
	}
	if (!input || !output) throw new Error("usage: ovh-test-shards.mjs --input <selected-lines-file> --output <dir>");
	const manifestPath = fileURLToPath(new URL("./ovh-test-durations.json", import.meta.url));
	const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
	if (!manifest || !manifest.metadata || !manifest.durations || typeof manifest.durations !== "object") throw new Error("duration manifest is malformed");
	const target = manifest.metadata.target_shard_duration_ms;
	const unknownDuration = manifest.metadata.default_unknown_duration_ms;
	if (typeof unknownDuration !== "number" || !Number.isFinite(unknownDuration) || unknownDuration < 0) throw new Error("duration manifest has invalid unknown fallback");
	const files = parseSelectedLines(await readFile(input, "utf8"));
	const durations = Object.fromEntries(files.map(file => [file, Object.hasOwn(manifest.durations, file) ? manifest.durations[file] : unknownDuration]));
	const plan = planShards(files, durations, target);
	await mkdir(output, { recursive: true });
	for (const shard of plan.shards) await atomicWrite(path.join(output, `shard-${shard.index}.txt`), shard.files.join("\n") + (shard.files.length ? "\n" : ""));
	await atomicWrite(path.join(output, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`);
	if (env.GITHUB_OUTPUT) {
		const matrix = JSON.stringify({ include: plan.shards.map(shard => ({
			index: shard.index,
			count: plan.shardCount,
			files: shard.files.length,
			projected_ms: shard.durationMs,
		})) });
		await mkdir(path.dirname(path.resolve(env.GITHUB_OUTPUT)), { recursive: true });
		await writeFile(env.GITHUB_OUTPUT, `matrix=${matrix}\n`, { flag: "a" });
	}
	return plan;
}

const invokedPath = process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedPath === import.meta.url) {
	runCli().catch(error => {
		console.error(error.message);
		process.exitCode = 1;
	});
}
