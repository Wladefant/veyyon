#!/usr/bin/env bun

/**
 * Proof script for Cloudflare Workers CI native addon variant verification.
 *
 * Verifies that the container loads the canonical native addon for the selected
 * variant without fallback, executes native visibleWidth, and reports its SHA256.
 */

import * as child_process from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";

export const CANONICAL_ADDON_FILES = {
	baseline: "natives/bridge/bindings/native/veyyon_natives.linux-x64-baseline.node",
	modern: "natives/bridge/bindings/native/veyyon_natives.linux-x64-modern.node",
};

export function runNativeVariantProof(options = {}) {
	const selectedVariant = options.variant || process.argv[2] || process.env.VEYYON_NATIVE_VARIANT;
	if (selectedVariant !== "baseline" && selectedVariant !== "modern") {
		throw new Error(
			`Native variant proof requires variant to be "baseline" or "modern" (current: "${selectedVariant || "unset"}").`,
		);
	}

	const repoRoot = options.repoRoot || path.resolve(path.join(import.meta.dir, "../.."));
	const canonicalRelPath = CANONICAL_ADDON_FILES[selectedVariant];
	const canonicalAbsPath = path.resolve(repoRoot, canonicalRelPath);

	if (!fs.existsSync(canonicalAbsPath)) {
		throw new Error(
			`Canonical native addon binary for variant "${selectedVariant}" not found: ${canonicalAbsPath}`,
		);
	}

	const canonicalReal = fs.realpathSync(canonicalAbsPath);
	const nativeIndexPath = path.resolve(repoRoot, "natives/bridge/bindings/native/index.js");
	if (!fs.existsSync(nativeIndexPath)) {
		throw new Error(`Native addon entrypoint not found: ${nativeIndexPath}`);
	}

	// Create a sandboxed guest directory so the probe never accesses host user data.
	const guestTmp = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-variant-proof-"));
	const probeScript = path.join(guestTmp, "probe.mjs");
	const importUrl = pathToFileURL(nativeIndexPath).href;

	fs.writeFileSync(
		probeScript,
		[
			`const native = await import(${JSON.stringify(importUrl)});`,
			`const width = native.visibleWidth("abc", 4);`,
			`process.stdout.write(String(width));`,
			"",
		].join("\n"),
		"utf8",
	);

	const childEnv = {
		...process.env,
		VEYYON_DEBUG_STARTUP: "1",
		VEYYON_NATIVE_VARIANT: selectedVariant,
		HOME: guestTmp,
		XDG_DATA_HOME: guestTmp,
		TMPDIR: guestTmp,
	};
	delete childEnv.VEYYON_NATIVE_CACHE_CREDENTIALS;
	delete childEnv.VEYYON_NATIVE_CACHE_WRITE_CREDENTIALS;
	delete childEnv.CLOUDFLARE_API_TOKEN;

	const bunBin = options.bunBin || process.env.BUN_BIN || process.execPath || "bun";
	let result;
	try {
		result = child_process.spawnSync(bunBin, [probeScript], {
			cwd: repoRoot,
			env: childEnv,
			encoding: "utf8",
			timeout: 15000,
			windowsHide: true,
		});
	} finally {
		try {
			fs.rmSync(guestTmp, { recursive: true, force: true });
		} catch {}
	}

	if (result.error) {
		if (result.error.code === "ETIMEDOUT") {
			throw new Error("Native variant proof timed out after 15s.");
		}
		throw result.error;
	}

	if (result.status !== 0) {
		throw new Error(
			`Native variant proof child process failed with exit code ${result.status}.\n` +
				`stdout: ${result.stdout || ""}\nstderr: ${result.stderr || ""}`,
		);
	}

	const stdout = (result.stdout || "").trim();
	if (stdout !== "3") {
		throw new Error(
			`Native variant proof expected visibleWidth("abc", 4) to output "3", got: "${stdout}".`,
		);
	}

	const stderr = result.stderr || "";
	const matches = [...stderr.matchAll(/^\[startup\]\s*native:require:(.+)$/gm)];
	if (matches.length === 0) {
		throw new Error(
			`Native variant proof startup marker missing: no "[startup] native:require:" lines in stderr.\nstderr:\n${stderr}`,
		);
	}

	const lastRequiredRaw = matches[matches.length - 1][1].trim();
	let lastRequiredReal;
	try {
		lastRequiredReal = fs.realpathSync(lastRequiredRaw);
	} catch {
		lastRequiredReal = path.resolve(lastRequiredRaw);
	}

	if (lastRequiredReal !== canonicalReal) {
		throw new Error(
			`Native variant proof loaded unexpected binary.\n` +
				`Expected canonical ${selectedVariant}: ${canonicalReal}\n` +
				`Actual loaded binary:                ${lastRequiredReal}`,
		);
	}

	if (selectedVariant === "modern") {
		if (lastRequiredReal.includes("baseline") || !lastRequiredReal.includes("modern")) {
			throw new Error(
				`Native variant proof modern selection fell back to baseline binary: ${lastRequiredReal}`,
			);
		}
		if (stderr.includes("native:skippedBrokenAddon") || stderr.includes("defaulting to the slower `baseline`")) {
			throw new Error(
				`Native variant proof modern selection logged fallback in stderr:\n${stderr}`,
			);
		}
		const allRequired = matches.map(m => m[1].trim());
		if (allRequired.some(p => p.includes("baseline"))) {
			throw new Error(
				`Native variant proof modern selection attempted baseline fallback: ${allRequired.join(", ")}`,
			);
		}
	}

	const fileBytes = fs.readFileSync(lastRequiredReal);
	const sha256 = crypto.createHash("sha256").update(fileBytes).digest("hex");
	console.log(`CLOUDFLARE_NATIVE_LOADED variant=${selectedVariant} sha256=${sha256}`);

	return {
		variant: selectedVariant,
		sha256,
		loadedPath: lastRequiredReal,
	};
}

const isMain =
	(typeof import.meta.main === "boolean" && import.meta.main) ||
	(Boolean(process.argv[1]) && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href);

if (isMain) {
	try {
		runNativeVariantProof();
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}
