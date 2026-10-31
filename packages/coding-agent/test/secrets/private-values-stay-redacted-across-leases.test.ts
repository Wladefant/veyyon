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
			const installed: Array<{ revision: number }> = [];
			const notices: string[] = [];
			fixture.runtime.attachSession({
				installSecretRuntime: lease => installed.push({ revision: lease.revision }),
				emitNotice: (_level, message) => notices.push(message),
			});
			const prior = fixture.runtime.lease;
			const valueA = "synthetic-private-value-alpha-123";
			const valueB = "synthetic-private-value-bravo-456";

			const ownerA = fixture.runtime.registerPrivateSecret(valueA);
			const leaseA = fixture.runtime.lease;
			const ownerB = fixture.runtime.registerPrivateSecret(valueB);
			const leaseB = fixture.runtime.lease;

			expect(ownerA.redact(`before ${valueA} after`)).not.toContain(valueA);
			expect(ownerB.redact(`before ${valueB} after`)).not.toContain(valueB);
			expect(leaseA.obfuscatePayload({ value: valueA })).not.toEqual({ value: valueA });
			expect(leaseB.obfuscatePayload({ value: valueB })).not.toEqual({ value: valueB });
			expect(prior.obfuscateText(valueA)).toBe(valueA);
			expect(Boolean(leaseB.expansionObfuscator)).toBe(expansionEnabled);
			if (leaseB.expansionObfuscator) {
				expect(leaseB.expansionObfuscator.hasNamedSecret(valueA)).toBe(false);
				expect(leaseB.expansionObfuscator.hasNamedSecret(valueB)).toBe(false);
			}
			expect(installed).toEqual([{ revision: leaseA.revision }, { revision: leaseB.revision }]);

			await fixture.runtime.refresh(fixture.cwd);
			expect(fixture.runtime.lease.obfuscateText(valueA)).not.toBe(valueA);
			expect(fixture.runtime.lease.obfuscateText(valueB)).not.toBe(valueB);
			const refreshed = fixture.runtime.lease;
			expect(Boolean(refreshed.expansionObfuscator)).toBe(expansionEnabled);
			if (refreshed.expansionObfuscator) {
				expect(refreshed.expansionObfuscator.hasNamedSecret(valueA)).toBe(false);
				expect(refreshed.expansionObfuscator.hasNamedSecret(valueB)).toBe(false);
			}
			for (const value of [valueA, valueB]) {
				const placeholder = refreshed.obfuscateText(value);
				const args = { command: placeholder };
				if (expansionEnabled) {
					expect(fixture.runtime.deobfuscateForExecution(
						refreshed, args, "bash", undefined,
					)).toEqual(args);
				} else {
					expect(() => fixture.runtime.deobfuscateForExecution(
						refreshed, args, "bash", undefined,
					)).toThrow("is no longer available");
				}
			}
			const ordinaryArgs = { command: "printf ordinary-text" };
			expect(fixture.runtime.deobfuscateForExecution(
				refreshed, ordinaryArgs, "bash", undefined,
			)).toEqual(ordinaryArgs);
			expect(notices.join("\n")).not.toContain(valueA);
			expect(notices.join("\n")).not.toContain(valueB);
		} finally {
			fixture.root.remove();
		}
	});

	it("refuses values too short to transform without exposing the input", async () => {
		const fixture = await createRuntime();
		try {
			expect(() => fixture.runtime.registerPrivateSecret("x")).toThrow(
				"Refusing a private secret value that cannot be safely redacted.",
			);
		} finally {
			fixture.root.remove();
		}
	});
});
