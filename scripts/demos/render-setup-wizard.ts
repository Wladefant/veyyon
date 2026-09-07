import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { Settings } from "../../packages/coding-agent/src/config/settings";
import { agentsSetupScene } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/agents";
import { glyphSetupScene } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/glyph";
import { importSetupScene } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/import";
import { providersSetupScene } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/providers";
import { themeSetupScene } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/theme";
import type {
	SetupScene,
	SetupWizardContext,
} from "../../packages/coding-agent/src/modes/terminal/setup-wizard/scenes/types";
import { SetupWizardComponent } from "../../packages/coding-agent/src/modes/terminal/setup-wizard/wizard-overlay";
import { renderDemo } from "./render-args";

const SCENES: readonly SetupScene[] = [
	providersSetupScene,
	agentsSetupScene,
	glyphSetupScene,
	themeSetupScene,
	importSetupScene,
];

function sleep(ms: number): Promise<void> {
	const { promise, resolve } = Promise.withResolvers<void>();
	setTimeout(resolve, ms);
	return promise;
}

await renderDemo(async ({ width, flag }) => {
	const rows = Number.parseInt(flag("rows", "30"), 10);
	const phase = flag("phase", "scene");
	const sceneName = flag("scene", "theme");
	const hoverText = flag("hover", "");

	const root = mkdtempSync(join(tmpdir(), "veyyon-wizard-proof-"));
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(projectDir, { recursive: true });

	try {
		const settings = await Settings.init({ cwd: projectDir, agentDir });
		const ctx = {
			settings,
			session: {
				modelRegistry: {
					authStorage: {
						hasAuth: () => false,
						has: () => false,
						getCredentialOrigin: () => undefined,
					},
					getAvailable: () => [],
				},
			},
			openInBrowser: () => {},
			showError: () => {},
			ui: {
				terminal: { rows },
				requestRender: () => {},
				setFocus: () => {},
				invalidate: () => {},
			},
		} as unknown as SetupWizardContext;

		const targetIndex = SCENES.findIndex(
			candidate => (candidate.stepLabel ?? candidate.id).toLowerCase() === sceneName,
		);
		if (targetIndex < 0) {
			const names = SCENES.map(candidate => (candidate.stepLabel ?? candidate.id).toLowerCase()).join(", ");
			throw new Error(`unknown scene "${sceneName}"; expected one of ${names}`);
		}
		for (const candidate of SCENES) await candidate.shouldRun?.(ctx);
		const component = new SetupWizardComponent(ctx, SCENES);
		void component.run();

		if (phase === "scene") {
			component.handleInput("\r");
			await sleep(700);
			for (let step = 0; step < targetIndex; step++) {
				component.handleInput("\x1b[C");
				await sleep(500);
			}
		} else if (phase !== "splash") {
			throw new Error(`unknown phase "${phase}"; expected scene or splash`);
		}

		let frame = component.render(width);
		if (hoverText) {
			const row = frame.findIndex(line => stripVTControlCharacters(line).includes(hoverText));
			if (row < 0) throw new Error(`--hover text "${hoverText}" is not in the frame`);
			const col = stripVTControlCharacters(frame[row] ?? "").indexOf(hoverText);
			component.handleInput(`\x1b[<35;${col + 1};${row + 1}M`);
			frame = component.render(width);
		}
		component.dispose();
		return frame;
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
