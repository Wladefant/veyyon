import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { OperatorNotices } from "@veyyon/kernel/session/operator-notices";
import { TempDir } from "@veyyon/utils";
import { SessionSecretRuntime } from "../../src/secrets/session-runtime";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

const getConfigRoot = useIsolatedConfigRoot();

async function createRuntime() {
	const root = TempDir.createSync("private-secret-runtime-");
	const cwd = path.resolve(root.join("project"));
	const agentDir = path.resolve(root.join("agent"));
	await Promise.all([
		fs.mkdir(cwd, { recursive: true }),
		fs.mkdir(agentDir, { recursive: true }),
	]);
	const settings = Settings.isolated();
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
	it("pins redaction to each owner and carries private values across refreshes only in redaction", async () => {
		const fixture = await createRuntime();
		try {
			const installed: Array<{ revision: number }> = [];
			fixture.runtime.attachSession({ installSecretRuntime: lease => installed.push(lease) });
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
			expect(leaseB.expansionObfuscator?.hasNamedSecret("synthetic-private-value-alpha-123")).toBe(false);
			expect(leaseB.expansionObfuscator?.hasNamedSecret("synthetic-private-value-bravo-456")).toBe(false);
			expect(leaseB.expansionObfuscator?.obfuscate(valueB)).toBe(valueB);
			expect(installed).toEqual([{ revision: leaseA.revision }, { revision: leaseB.revision }]);

			await fixture.runtime.refresh(fixture.cwd);
			expect(fixture.runtime.lease.obfuscateText(valueA)).not.toBe(valueA);
			expect(fixture.runtime.lease.obfuscateText(valueB)).not.toBe(valueB);
			expect(fixture.runtime.lease.expansionObfuscator?.obfuscate(valueA)).toBe(valueA);
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
