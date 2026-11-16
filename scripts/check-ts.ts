import { spawn } from "node:child_process";

export type StepRunner = (command: string[]) => Promise<number>;

function spawnCommand(command: string[]): Promise<number> {
	const { promise, resolve, reject } = Promise.withResolvers<number>();
	const [cmd, ...args] = command;
	if (!cmd) {
		reject(new Error("Empty command"));
		return promise;
	}
	const child = spawn(cmd, args, {
		stdio: "inherit",
		windowsHide: true,
	});
	child.on("error", reject);
	child.on("close", (code, signal) => {
		if (code !== null) {
			resolve(code);
		} else {
			resolve(signal ? 1 : 0);
		}
	});
	return promise;
}

/**
 * Run root tools typecheck and workspace typechecks without short-circuiting so
 * workspace diagnostics still surface when `tsconfig.tools.json` fails.
 */
export async function runCheckTs(runStep: StepRunner = spawnCommand): Promise<number> {
	let toolsCode = 0;
	try {
		toolsCode = await runStep(["bun", "run", "check:types"]);
	} catch (error) {
		console.error("Root tools typecheck failed to run:", error instanceof Error ? error.message : String(error));
		toolsCode = 1;
	}

	let workspacesCode = 0;
	try {
		workspacesCode = await runStep(["bun", "run", "--workspaces", "--if-present", "check:types"]);
	} catch (error) {
		console.error("Workspace typechecks failed to run:", error instanceof Error ? error.message : String(error));
		workspacesCode = 1;
	}

	if (toolsCode !== 0) return toolsCode;
	if (workspacesCode !== 0) return workspacesCode;
	return 0;
}

if (import.meta.main) {
	const exitCode = await runCheckTs();
	if (exitCode !== 0) {
		process.exitCode = exitCode;
	}
}
