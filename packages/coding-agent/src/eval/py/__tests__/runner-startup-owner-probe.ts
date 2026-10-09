import { KernelSessionPool } from "../../executor-base";
import type { SessionKernel } from "../../kernel-base";
import { PythonKernel } from "../kernel";

const gate = Promise.withResolvers<void>();
const pool = new KernelSessionPool({
	languageName: "Python",
	logLabel: "runner-startup-probe",
	startKernel: async (): Promise<SessionKernel> => {
		await gate.promise;
		const kernel = await PythonKernel.start({ cwd: process.cwd() });
		await kernel.execute("import os; print(os.getpid())", {
			onChunk: text => {
				process.stdout.write(text);
			},
		});
		console.log("EVAL_READY");
		return kernel;
	},
});
const abort = new AbortController();
const acquiring = pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "lane", signal: abort.signal });
const started = pool.startingSessions.get("key")!.promise;
const shared =
	process.argv[2] === "shared"
		? pool.acquireSession("key", "session", process.cwd(), { kernelOwnerId: "other" })
		: undefined;
abort.abort(new Error("lane cancelled during startup"));
await acquiring.catch(() => {});
gate.resolve();
await started;
if (shared) {
	const session = await shared;
	await session.kernel.execute("print('SHARED_EXECUTED', flush=True)", {
		onChunk: text => {
			process.stdout.write(text);
		},
	});
	await pool.disposeByOwner("other");
}
console.log("LANE_FINISHED");
// Keep the host alive so the parent-death guard cannot conceal lost lane ownership.
// This real-process fixture must stay alive while the OS checks its runner.
await Bun.sleep(120_000);
