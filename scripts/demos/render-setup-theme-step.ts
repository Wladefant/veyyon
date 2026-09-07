import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { themeSetupScene } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/theme";
import { renderDemo } from "./render-args";

const TOGGLE_ROW: Record<string, number> = { colorblind: 4, ascii: 5 };

await renderDemo(async ({ width, flag }) => {
	const toggles = flag("toggles", "")
		.split(",")
		.map(name => name.trim())
		.filter(Boolean);

	const root = mkdtempSync(join(tmpdir(), "veyyon-setup-proof-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	try {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const scene = themeSetupScene.mount({
			ctx: { settings, ui: { invalidate: () => {} } } as never,
			requestRender: () => {},
			finish: () => {},
			skipSetup: () => {},
			setFocus: () => {},
			restoreFocus: () => {},
		});

		for (const name of toggles) {
			const row = TOGGLE_ROW[name];
			if (row === undefined) throw new Error(`unknown toggle "${name}"; expected colorblind or ascii`);
			scene.handleInput?.(String(row + 1));
			scene.handleInput?.("\r");
			const { promise, resolve } = Promise.withResolvers<void>();
			setTimeout(resolve, 120);
			await promise;
		}

		return scene.render(width);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
