import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { TempDir } from "@veyyon/utils";
import { HOST_HOME_ENV, SANDBOX_MARKER_ENV } from "../../utils/test/helpers/sandbox-gate";

function probe(helper: string, admitted: boolean) {
	using tmp = TempDir.createSync("veyyon-fixture-bootstrap-");
	const home = tmp.join("home");
	const target = tmp.join("home", ".veyyon", "probe");
	mkdirSync(tmp.join("home", ".veyyon"), { recursive: true });
	// A production dependency reads this key at module load if it sees the original home.
	writeFileSync(tmp.join("home", ".env"), `VEYYON_CODING_AGENT_DIR=${JSON.stringify(tmp.join("agent"))}\n`);
	const driver = `
		import ${JSON.stringify(import.meta.resolve(`./helpers/${helper}.ts`))};
		console.log(process.env.VEYYON_CODING_AGENT_DIR ? "read original home" : "ignored original home");
		try { await Bun.write(${JSON.stringify(target)}, "probe"); }
		catch (error) { if (!String(error).includes("TRIPWIRE")) throw error; }
	`;
	// Omit inherited directory overrides and preloads. Both children stay inside the same kernel guest.
	const result = Bun.spawnSync([process.execPath, "--no-env-file", "--eval", driver], {
		cwd: tmp.path(),
		env: {
			PATH: process.env.PATH,
			HOME: home,
			USERPROFILE: home,
			VEYYON_CONFIG_DIR: tmp.join("config"),
			[HOST_HOME_ENV]: process.env[HOST_HOME_ENV],
			[SANDBOX_MARKER_ENV]: admitted ? process.env[SANDBOX_MARKER_ENV] : undefined,
		},
		stderr: "pipe",
		stdout: "pipe",
		timeout: 15_000,
	});
	return { ...result, wrote: existsSync(target) };
}

for (const helper of ["tool-session", "every-tool", "integration-workspace"]) {
	test(`${helper} refuses a standalone import without sandbox admission`, () => {
		const result = probe(helper, false);
		expect(result.stderr.toString()).toContain(
			"REFUSED: this test process cannot prove the operator's home is out of reach",
		);
		expect(result.exitCode).toBe(1);
		expect(result.stdout.toString()).toBe("");
		expect(result.wrote).toBe(false);
	}, 20_000);

	test(`${helper} redirects home before its dependencies load and installs the tripwire`, () => {
		const result = probe(helper, true);
		if (result.exitCode !== 0) throw new Error(result.stderr.toString());
		expect(result.stdout.toString().trim()).toBe("ignored original home");
		expect(result.wrote).toBe(false);
	}, 20_000);
}
