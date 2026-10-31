import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { TempDir } from "@veyyon/utils";
import { SessionSecretRuntime } from "../../src/secrets/session-runtime";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const getConfigRoot = useIsolatedConfigRoot();

async function createRuntime(expansionEnabled = false) {
	const root = TempDir.createSync("private-secret-runtime-");
	const cwd = path.resolve(root.join("project"));
	const agentDir = path.resolve(root.join("agent"));
	await Promise.all([
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
	]);
	const settings = Settings.isolated({ "secrets.enabled": expansionEnabled });
	const runtime = await SessionSecretRuntime.load(
		{
			settings,
			globalConfigRoot: getConfigRoot(),
			agentDir,
			operatorNotices: new OperatorNotices(),
			getCwd: () => cwd,
		},
		cwd,
	);
	return { root, cwd, settings, runtime };
}

describe("private secret runtime registration", () => {
	it.each([false, true])("keeps private values redaction-only across refreshes with expansion=%s", async expansionEnabled => {
		const fixture = await createRuntime(expansionEnabled);
		try {
			const installed: Array<{ revision: number; obfuscateText(text: string): string }> = [];
			const notices: string[] = [];
			fixture.runtime.attachSession({
				installSecretRuntime: lease => installed.push(lease),
				emitNotice: (_level, message) => notices.push(message),
			});
			const prior = fixture.runtime.lease;
			const values = [
				"synthetic-private-value-alpha-123",
				"ordinary-long-private-value-bravo-456789",
				"私有の値・秘密-long-value-東京",
				"private\nvalue\nwith\nembedded\nlines",
				"shell ; $(printf synthetic) | & > < ` * ? [ ]",
			];

			const owners = values.map(value => fixture.runtime.registerPrivateSecret(value));
			const currentLease = fixture.runtime.lease;
			for (const [index, value] of values.entries()) {
				expect(owners[index]!.redact(`before ${value} after`)).not.toContain(value);
				expect(installed[index]!.obfuscateText(value)).not.toContain(value);
				expect(currentLease.obfuscateText(value)).not.toContain(value);
			}
			expect(prior.obfuscateText(values[0]!)).toBe(values[0]);
			expect(currentLease.expansionObfuscator?.hasNamedSecret(values[0]!) ?? false).toBe(false);
			expect(currentLease.expansionObfuscator?.obfuscate(values[0]!) ?? values[0]).toBe(values[0]);
			expect(installed.map(lease => lease.revision)).toEqual(values.map((_, index) => prior.revision + index + 1));

			await fixture.runtime.refresh(fixture.cwd);
			const refreshedLease = fixture.runtime.lease;
			expect(Boolean(refreshedLease.expansionObfuscator)).toBe(expansionEnabled);
			for (const value of values) {
				expect(refreshedLease.obfuscateText(value)).not.toContain(value);
				expect(refreshedLease.expansionObfuscator?.obfuscate(value) ?? value).toBe(value);
				const args = { command: refreshedLease.obfuscateText(value) };
				if (expansionEnabled) {
					expect(fixture.runtime.deobfuscateForExecution(refreshedLease, args, "bash", undefined)).toEqual(args);
				} else {
					expect(() => fixture.runtime.deobfuscateForExecution(refreshedLease, args, "bash", undefined)).toThrow(
						"is no longer available",
					);
				}
				expect(notices.join("\n")).not.toContain(value);
			}
			expect(currentLease.obfuscateText(values[0]!)).not.toBe(values[0]);
			const ordinaryArgs = { command: "printf ordinary-text" };
			expect(fixture.runtime.deobfuscateForExecution(refreshedLease, ordinaryArgs, "bash", undefined)).toEqual(
				ordinaryArgs,
			);
		} finally {
			fixture.root.remove();
		}
	});

	it("refuses values too short to transform before execution or vault operations", async () => {
		const fixture = await createRuntime();
		try {
			let executionMarker = false;
			for (const value of ["x", "ab", "short1", "short2", "short3", "short4", "short5"]) {
				expect(() => {
					fixture.runtime.registerPrivateSecret(value);
					executionMarker = true;
				}).toThrow("Refusing a private secret value that cannot be safely redacted.");
				expect(executionMarker).toBe(false);
			}
		} finally {
			fixture.root.remove();
		}
	});
});

