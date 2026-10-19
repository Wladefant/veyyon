#!/usr/bin/env node
// Reads the optional Cloudflare lane target manifest. A non-empty manifest lists the only test
// files the lane runs: one path per line, blank lines and `#` comments ignored. The lane fails
// on a manifest that names no path; it never falls back to a wider selection.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function readLaneTargets(text) {
	const targets = [];
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		targets.push(line.replace(/^\.\//, ""));
	}
	if (targets.length === 0) throw new Error("lane target manifest lists no test paths");
	return targets;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const manifest = process.argv[2];
	if (!manifest) {
		console.error("usage: lane-targets.mjs <manifest>");
		process.exit(2);
	}
	try {
		process.stdout.write(`${readLaneTargets(readFileSync(manifest, "utf8")).join("\n")}\n`);
	} catch (error) {
		console.error(`ERROR: ${error.message}`);
		process.exit(1);
	}
}
