import { expect, it, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BashTool } from "@veyyon/coding-agent/tools/shell/bash";
import type { ClientBridge } from "@veyyon/kernel/session/client-bridge";
import { makeToolSession } from "../helpers/tool-session";

const helper = join(tmpdir(), "veyyon build slot fixture", "build_slot.py").replaceAll("\\", "/");
const wrap = (command: string, options = "--class light --timeout 15") =>
	`python '${helper}' run slot-test ${options} -- ${command}`;

function fixture() {
	const createTerminal = mock<NonNullable<ClientBridge["createTerminal"]>>(async () => ({
		terminalId: "build-slot-fixture",
		waitForExit: async () => ({ exitCode: 0, signal: null }),
		currentOutput: async () => ({ output: "terminal completed", truncated: false }),
		kill: async () => {},
		release: async () => {},
	}));
	const session = makeToolSession({
		cwd: tmpdir(),
		skills: [],
		settings: {
			get: () => undefined,
			getShellConfig: () => ({ shell: "/bin/bash", args: ["-c"], env: {} }),
		},
		getClientBridge: () => ({ capabilities: { terminal: true }, createTerminal }),
	});
	const tool = new BashTool(session, { buildSlotPath: helper });
	return {
		createTerminal,
		run: (command: string, env?: Record<string, string>) => tool.execute("build-slot-test", { command, env }),
	};
}

it.each([
	"node --test",
	"npm test",
	"yarn test",
	"bun test",
	"vitest",
	"jest",
	"pytest",
	"tsc",
	"echo ready && CI=1 command yarn test",
	"'C:/node_modules/.bin/jest.cmd' --runInBand",
])("refuses a raw runner before terminal creation: %s", async command => {
	const { run, createTerminal } = fixture();
	await expect(run(command)).rejects.toThrow("build_slot.py");
	expect(createTerminal).not.toHaveBeenCalled();
});

it.each([
	"python './build_slot.py' run slot-test -- yarn test",
	wrap("yarn test", "--force"),
	wrap("yarn test", "--for"),
	`${wrap("yarn test")} && pytest`,
])("does not treat an apparent wrapper as permission to run a raw test: %s", async command => {
	const { run, createTerminal } = fixture();
	await expect(run(command)).rejects.toThrow("build_slot.py");
	expect(createTerminal).not.toHaveBeenCalled();
});

it("refuses an explicit wrapper with caller-supplied admission inputs", async () => {
	const { run, createTerminal } = fixture();
	await expect(run(wrap("yarn test"), { BUILD_SLOT_HELD: "copied" })).rejects.toThrow("build_slot.py");
	expect(createTerminal).not.toHaveBeenCalled();
});

it("passes the canonical explicit wrapper and its payload to the terminal unchanged", async () => {
	const { run, createTerminal } = fixture();
	const command = wrap("yarn test");
	const result = await run(command);
	expect(result.isError).not.toBe(true);
	expect(createTerminal).toHaveBeenCalledTimes(1);
	expect(createTerminal.mock.calls[0]?.[0].args).toEqual(["-c", `{\n${command}\n\n} </dev/null`]);
});

it("does not mistake runner names in command arguments for a launch", async () => {
	const { run, createTerminal } = fixture();
	await run("printf '%s\\n' 'yarn test; pytest'");
	expect(createTerminal).toHaveBeenCalledTimes(1);
});
