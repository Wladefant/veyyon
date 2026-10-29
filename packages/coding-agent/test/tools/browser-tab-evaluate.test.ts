import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { browserToolView } from "@veyyon/coding-agent/tools/web/browser/view";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";
const PASSWORD_CANARIES = {
	main: ["MAIN_", "PASSWORD_SENTINEL"].join(""),
	disabled: ["DISABLED_", "PASSWORD_SENTINEL"].join(""),
	shadow: ["SHADOW_", "PASSWORD_SENTINEL"].join(""),
	frame: ["FRAME_", "PASSWORD_SENTINEL"].join(""),
} as const;

function makeSession(): ToolSession {
	const sessionId = `browser-tab-evaluate-${process.pid}-${crypto.randomUUID()}`;
	return {
		cwd: "/tmp/test",
		getSessionId: () => sessionId,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
}

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

describe.skipIf(!CHROMIUM_AVAILABLE)("browser tab evaluation", () => {
	// Launches real headless Chromium; CI cold start easily exceeds bun's 5s default.
	it("runs tab.evaluate in the page's main JavaScript world", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `main-world-${process.pid}`;

		try {
			await tool.execute("open", {
				action: "open",
				name,
				url: "data:text/html,<script>globalThis.__veyyonMainWorld = 42</script>",
			});
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: "return await tab.evaluate(() => globalThis.__veyyonMainWorld);",
			});

			expect(result.content).toEqual([{ type: "text", text: "42" }]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 30_000);
});

const PASSWORD_HTML = `<!doctype html><html><body>
	<main aria-label="Synthetic credential form">
		<label for="primary-secret">Primary password</label>
		<input id="primary-secret" type="password">
		<label for="ordinary-text">Display name</label>
		<input id="ordinary-text" type="text" value="VISIBLE_TEXT_SENTINEL">
		<label for="disabled-secret">Disabled password</label>
		<input id="disabled-secret" type="password" disabled>
		<div id="shadow-host"></div>
		<iframe title="Nested credential frame" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;label for='frame-secret'&gt;Frame password&lt;/label&gt;&lt;input id='frame-secret' type='password'&gt;&lt;/body&gt;&lt;/html&gt;"></iframe>
	</main>
	<script>
		const root = document.querySelector('#shadow-host').attachShadow({mode: 'open'});
		root.innerHTML = '<label for="shadow-secret">Shadow password</label><input id="shadow-secret" type="password">';
	</script>
</body></html>`;

async function readPasswordPage(expression: string): Promise<string> {
	const tool = new BrowserTool(makeSession());
	const name = `password-observation-${process.pid}-${crypto.randomUUID()}`;
	const url = `data:text/html;charset=utf-8,${encodeURIComponent(PASSWORD_HTML)}`;
	const runArgs = {
		action: "run" as const,
		name,
		code: `
			await tab.fill('#primary-secret', ['MAIN_', 'PASSWORD_SENTINEL'].join(''));
			await tab.evaluate(() => {
				document.querySelector('#disabled-secret').value = ['DISABLED_', 'PASSWORD_SENTINEL'].join('');
				document.querySelector('#shadow-host').shadowRoot.querySelector('input').value = ['SHADOW_', 'PASSWORD_SENTINEL'].join('');
				document.querySelector('iframe').contentDocument.querySelector('input').value = ['FRAME_', 'PASSWORD_SENTINEL'].join('');
			});
			return await (${expression});
		`,
	};
	try {
		await tool.execute("open", { action: "open", name, url });
		const result = await tool.execute("run", runArgs);
		const rendered = browserToolView.renderResult(result, { expanded: true }, runArgs);
		return JSON.stringify({ result, rendered });
	} finally {
		await tool.execute("close", { action: "close", name, kill: true });
	}
}
async function readPasswordApiError(): Promise<string> {
	const tool = new BrowserTool(makeSession());
	const name = `password-observation-error-${process.pid}-${crypto.randomUUID()}`;
	const url = `data:text/html;charset=utf-8,${encodeURIComponent(PASSWORD_HTML)}`;

	try {
		await tool.execute("open", { action: "open", name, url });
		try {
			await tool.execute("run", {
				action: "run",
				name,
				code: `
					await tab.fill('#primary-secret', ['MAIN_', 'PASSWORD_SENTINEL'].join(''));
					await tab.evaluate(() => {
						document.querySelector('#disabled-secret').value = ['DISABLED_', 'PASSWORD_SENTINEL'].join('');
						document.querySelector('#shadow-host').shadowRoot.querySelector('input').value = ['SHADOW_', 'PASSWORD_SENTINEL'].join('');
						document.querySelector('iframe').contentDocument.querySelector('input').value = ['FRAME_', 'PASSWORD_SENTINEL'].join('');
					});
					const observation = await tab.observe({ includeAll: true });
					display(observation);
					await tab.ariaSnapshot('#missing-synthetic-element');
				`,
			});
			throw new Error("Missing-selector browser API call unexpectedly succeeded");
		} catch (error) {
			if (error instanceof Error && error.message === "Missing-selector browser API call unexpectedly succeeded") throw error;
			return JSON.stringify({
				name: error instanceof Error ? error.name : undefined,
				message: error instanceof Error ? error.message : String(error),
				context: "context" in Object(error) ? Object(error).context : undefined,
				partialRunOutput: "partialRunOutput" in Object(error) ? Object(error).partialRunOutput : undefined,
			});
		}
	} finally {
		await tool.execute("close", { action: "close", name, kill: true });
	}
}

describe.skipIf(!CHROMIUM_AVAILABLE)("browser password observation", () => {
	it("does not disclose password values in the default ARIA snapshot", async () => {
		const output = await readPasswordPage("tab.ariaSnapshot()");
		const evidence = JSON.parse(output) as {
			result: { details?: { result?: unknown } };
			rendered: unknown;
		};
		expect(typeof evidence.result.details?.result).toBe("string");
		expect(evidence.rendered).toBeDefined();

		expect(output).toContain("Primary password");
		expect(output).toContain("Shadow password");
		expect(output).toContain("Frame password");
		expect(output).toContain("VISIBLE_TEXT_SENTINEL");
		expect(output).not.toContain(PASSWORD_CANARIES.main);
		expect(output).not.toContain(PASSWORD_CANARIES.shadow);
		expect(output).not.toContain(PASSWORD_CANARIES.frame);
		expect(output).not.toContain(PASSWORD_CANARIES.disabled);
	}, 60_000);

	it("does not disclose password values in a full observation", async () => {
		const output = await readPasswordPage("tab.observe({ includeAll: true })");

		expect(output).toContain("Primary password");
		expect(output).toContain("Display name");
		expect(output).toContain("VISIBLE_TEXT_SENTINEL");
		expect(output).not.toContain(PASSWORD_CANARIES.main);
		expect(output).not.toContain(PASSWORD_CANARIES.shadow);
		expect(output).not.toContain(PASSWORD_CANARIES.frame);
		expect(output).not.toContain(PASSWORD_CANARIES.disabled);
	}, 60_000);
	it("leaves password values undefined in observed entries", async () => {
		const output = await readPasswordPage(`(async () => {
			const expected = ['Disabled password', 'Primary password', 'Shadow password'];
			const entries = (await tab.observe({ includeAll: true })).elements
				.filter(entry => expected.includes(entry.name ?? ''));
			const labels = entries
				.filter(entry => entry.role === 'StaticText')
				.map(entry => entry.name ?? '')
				.sort();
			const controls = entries.filter(entry => entry.role === 'textbox');
			const controlNames = controls.map(entry => entry.name ?? '').sort();
			if (labels.join('|') !== expected.slice().sort().join('|')) {
				throw new Error('Password observation omitted a label');
			}
			if (controlNames.join('|') !== expected.slice().sort().join('|')) {
				throw new Error('Password observation omitted a textbox control');
			}
			if (entries.some(entry => entry.value !== undefined)) {
				throw new Error('Password observation exposed a password value');
			}
			return { passwordLabels: labels, passwordControlNames: controlNames, allValuesUndefined: true };
		})()`);

		expect(output).toContain('Primary password');
		expect(output).toContain('Disabled password');
		expect(output).toContain('Shadow password');
		expect(output).toContain('passwordControlNames');
		expect(output).toContain('allValuesUndefined');
		expect(output).not.toContain(PASSWORD_CANARIES.disabled);
		expect(output).not.toContain(PASSWORD_CANARIES.shadow);
		expect(output).not.toContain(PASSWORD_CANARIES.frame);
	}, 60_000);

	it("keeps a selected-root snapshot usable", async () => {
		const output = await readPasswordPage("tab.ariaSnapshot('main')");

		expect(output).toContain("Primary password");
		expect(output).toContain("Shadow password");
		expect(output).toContain("Frame password");
		expect(output).toContain("VISIBLE_TEXT_SENTINEL");
		expect(output).not.toContain(PASSWORD_CANARIES.main);
		expect(output).not.toContain(PASSWORD_CANARIES.disabled);
		expect(output).not.toContain(PASSWORD_CANARIES.shadow);
		expect(output).not.toContain(PASSWORD_CANARIES.frame);
	}, 60_000);

	it("does not echo canaries in a missing-selector API error after display", async () => {
		const output = await readPasswordApiError();

		expect(JSON.parse(output)).toMatchObject({ name: "ToolError" });
		expect(output).toContain("matched no element");
		expect(output).toContain("Primary password");
		expect(output).toContain("Display name");
		expect(output).toContain("VISIBLE_TEXT_SENTINEL");
		expect(output).not.toContain(PASSWORD_CANARIES.main);
		expect(output).not.toContain(PASSWORD_CANARIES.disabled);
		expect(output).not.toContain(PASSWORD_CANARIES.shadow);
		expect(output).not.toContain(PASSWORD_CANARIES.frame);
	}, 60_000);
});
