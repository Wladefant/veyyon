import { PythonKernel } from "../kernel";

const kernel = await PythonKernel.start({ cwd: process.cwd() });
await kernel.execute("import os; print(os.getpid())", {
	onChunk: text => {
		process.stdout.write(text);
	},
});
console.log("EVAL_READY");
if (process.argv[2] === "exit") {
	await kernel.shutdown();
	console.log("EVAL_EXIT");
} else {
	await kernel.execute("import time; print('BLOCK_STARTED', flush=True); time.sleep(120)", {
		onChunk: text => {
			process.stdout.write(text);
		},
	});
}
