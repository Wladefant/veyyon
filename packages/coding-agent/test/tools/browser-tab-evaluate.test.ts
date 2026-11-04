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
const XHTML_PASSWORD_CANARIES = [
	["XHTML_", "PASSWORD_SENTINEL"].join(""),
	["PREFIXED_", "PASSWORD_SENTINEL"].join(""),
] as const;
const XHTML_DISPLAY_TEXT = ["VISIBLE_", "XHTML_TEXT_SENTINEL"].join("");

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
		<button aria-labelledby="primary-secret">Confirm</button>
		<label for="ordinary-text">Display name</label>
		<input id="ordinary-text" type="text" value="VISIBLE_TEXT_SENTINEL">
		<label for="disabled-secret">Disabled password</label>
		<input id="disabled-secret" type="password" disabled>
		<div id="shadow-host"></div>
		<iframe title="Nested credential frame" srcdoc="&lt;!doctype html&gt;&lt;html&gt;&lt;body&gt;&lt;label for='frame-secret'&gt;Frame password&lt;/label&gt;&lt;input id='frame-secret' type='password'&gt;&lt;button aria-labelledby='frame-secret'&gt;Confirm&lt;/button&gt;&lt;/body&gt;&lt;/html&gt;"></iframe>
	</main>
	<script>
		const root = document.querySelector('#shadow-host').attachShadow({mode: 'open'});
		root.innerHTML = '<label for="shadow-secret">Shadow password</label><input id="shadow-secret" type="password"><button aria-labelledby="shadow-secret">Confirm</button>';
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
			if (error instanceof Error && error.message === "Missing-selector browser API call unexpectedly succeeded")
				throw error;
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
	// WHY: Password values can enter another control's name through a label traversal.
	// Exercise each embedded-value role; page-authored text that copies a secret is outside this boundary.
	it("uses password labels, never password values, when naming another control", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `indirect-password-${process.pid}-${crypto.randomUUID()}`;
		const runArgs = {
			action: "run" as const,
			name,
			code: `
				await tab.evaluate(() => {
					const secret = ['INDIRECT_', 'PASSWORD_SENTINEL'].join('');
					const roles = ['', 'textbox', 'combobox', 'listbox', 'progressbar', 'scrollbar', 'slider', 'spinbutton', 'meter'];
					for (const role of roles) {
						const input = document.createElement('input');
						input.type = 'password';
						input.id = 'secret-' + (role || 'native');
						input.setAttribute('value', secret);
						input.setAttribute('aria-label', 'Safe ' + (role || 'native') + ' label');
						if (role) input.setAttribute('role', role);
						const button = document.createElement('button');
						button.setAttribute('aria-labelledby', input.id);
						document.body.append(input, button);
					}
					const ordinary = document.createElement('input');
					ordinary.id = 'ordinary';
					ordinary.value = 'Visible ordinary value';
					const ordinaryButton = document.createElement('button');
					ordinaryButton.setAttribute('aria-labelledby', ordinary.id);
					document.body.append(ordinary, ordinaryButton);
					const label = document.createElement('label');
					label.innerHTML = 'Notify <input type="checkbox"><input type="password" aria-label="Safe nested label">';
					label.querySelector('input[type="password"]').value = secret;
					const descendant = document.createElement('div');
					descendant.setAttribute('role', 'button');
					descendant.innerHTML = 'Continue <input type="password" aria-label="Safe descendant label">';
					descendant.querySelector('input').value = secret;
					document.body.append(label, descendant);
				});
				return await tab.ariaSnapshot();
			`,
		};
		try {
			await tool.execute("open", { action: "open", name, url: "data:text/html,<body></body>" });
			const result = await tool.execute("run", runArgs);
			const rendered = browserToolView.renderResult(result, { expanded: true }, runArgs);
			const output = JSON.stringify({ result, rendered });
			const snapshot = result.details?.result;
			expect(typeof snapshot).toBe("string");
			expect(snapshot).toContain('button "Safe native label"');
			expect(snapshot).toContain('button "Safe combobox label"');
			expect(snapshot).toContain('button "Safe slider label"');
			expect(snapshot).toContain('checkbox "Notify Safe nested label"');
			expect(snapshot).toContain('button "Continue Safe descendant label"');
			expect(snapshot).toContain('button "Visible ordinary value"');
			expect(output).not.toContain(["INDIRECT_", "PASSWORD_SENTINEL"].join(""));
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 60_000);

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

		expect(output).toContain("Primary password");
		expect(output).toContain("Disabled password");
		expect(output).toContain("Shadow password");
		expect(output).toContain("passwordControlNames");
		expect(output).toContain("allValuesUndefined");
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
	it("masks unprefixed and prefixed XHTML password values", async () => {
		const tool = new BrowserTool(makeSession());
		const name = `xhtml-password-${process.pid}-${crypto.randomUUID()}`;
		const xhtml = `<?xml version="1.0" encoding="UTF-8"?>
			<html xmlns="http://www.w3.org/1999/xhtml" xmlns:h="http://www.w3.org/1999/xhtml">
				<head><title>Synthetic XHTML credential form</title></head>
				<body>
					<label for="xhtml-secret">XHTML password</label>
					<input id="xhtml-secret" type="password" />
					<label for="prefixed-secret">Prefixed XHTML password</label>
					<h:input id="prefixed-secret" type="password" />
					<label for="xhtml-text">XHTML display</label>
					<input id="xhtml-text" type="text" />
				</body>
			</html>`;
		const url = `data:application/xhtml+xml;charset=utf-8,${encodeURIComponent(xhtml)}`;
		const runArgs = {
			action: "run" as const,
			name,
			code: `
				const plainSecret = ['XHTML_', 'PASSWORD_SENTINEL'].join('');
				const prefixedSecret = ['PREFIXED_', 'PASSWORD_SENTINEL'].join('');
				const ordinaryExpected = ['VISIBLE_', 'XHTML_TEXT_SENTINEL'].join('');
				await tab.fill('#xhtml-secret', plainSecret);
				await tab.evaluate(value => {
					const control = document.querySelector('#prefixed-secret');
					if (!control) throw new Error('missing prefixed XHTML password');
					control.setAttribute('value', value);
				}, prefixedSecret);
				await tab.fill('#xhtml-text', ordinaryExpected);
				const seeded = await tab.evaluate(() => ({
					contentType: document.contentType,
					plainSecret: document.querySelector('#xhtml-secret')?.value,
					prefixedSecret: document.querySelector('#prefixed-secret')?.getAttribute('value'),
					ordinaryValue: document.querySelector('#xhtml-text')?.value,
				}));
				if (
					seeded.contentType !== 'application/xhtml+xml' ||
					seeded.plainSecret !== plainSecret ||
					seeded.prefixedSecret !== prefixedSecret ||
					seeded.ordinaryValue !== ordinaryExpected
				) {
					throw new Error('XHTML fixture values did not match before observation');
				}
				const observation = await tab.observe({ includeAll: true });
				const expectedLabels = ['Prefixed XHTML password', 'XHTML display', 'XHTML password'];
				const expectedPasswords = ['Prefixed XHTML password', 'XHTML password'];
				const labels = observation.elements
					.filter(entry => entry.role === 'StaticText' && expectedLabels.includes(entry.name ?? ''))
					.map(entry => entry.name ?? '')
					.sort();
				const passwordControls = observation.elements.filter(
					entry => entry.role === 'textbox' && expectedPasswords.includes(entry.name ?? ''),
				);
				const passwordControlNames = passwordControls.map(entry => entry.name ?? '').sort();
				const ordinaryControl = observation.elements.find(
					entry => entry.role === 'textbox' && entry.name === 'XHTML display',
				);
				if (labels.join('|') !== expectedLabels.slice().sort().join('|')) {
					throw new Error('XHTML observation omitted a fixture label');
				}
				if (passwordControlNames.join('|') !== expectedPasswords.slice().sort().join('|')) {
					throw new Error('XHTML observation omitted a password textbox');
				}
				if (passwordControls.some(entry => entry.value !== undefined)) {
					throw new Error('XHTML observation exposed a password value');
				}
				if (!ordinaryControl || ordinaryControl.value !== ordinaryExpected) {
					throw new Error('XHTML observation did not preserve the seeded ordinary text');
				}
				return {
					labels,
					passwordControlNames,
					passwordValuesUndefined: true,
					ordinaryTextLabel: ordinaryControl.name,
					ordinaryTextValue: ordinaryControl.value,
				};
			`,
		};
		try {
			await tool.execute("open", { action: "open", name, url });
			const result = await tool.execute("run", runArgs);
			const rendered = browserToolView.renderResult(result, { expanded: true }, runArgs);
			const output = JSON.stringify({ result, rendered });
			expect(typeof result.details?.result).toBe("string");
			expect(output).toContain("XHTML password");
			expect(output).toContain("Prefixed XHTML password");
			expect(output).toContain("XHTML display");
			expect(output).toContain(XHTML_DISPLAY_TEXT);
			expect(output).toContain("passwordValuesUndefined");
			expect(output).not.toContain(XHTML_PASSWORD_CANARIES[0]);
			expect(output).not.toContain(XHTML_PASSWORD_CANARIES[1]);
		} finally {
			await tool.execute("close", { action: "close", name, kill: true });
		}
	}, 60_000);
});
