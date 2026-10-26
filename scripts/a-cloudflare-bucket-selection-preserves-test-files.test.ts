import { describe, expect, it } from "bun:test";
import { commandsForMode, fastWorkspacePackages, nativeAndIntegrationPackages, validModes } from "./ci-test-ts";

describe("Cloudflare workspace test bucket selection", () => {
	it("registers workspace-cloudflare as a supported runner mode", () => {
		expect(validModes["workspace-cloudflare"]).toBe(true);
	});

	it("runs every fast workspace package and isolates, rather than omits, catalog suites", async () => {
		const commands = await commandsForMode("workspace-cloudflare");
		const ordinaryPackages = commands
			.filter(command => command.label !== "packages/catalog (isolated)")
			.map(command => command.label)
			.sort();
		expect(ordinaryPackages).toEqual([...fastWorkspacePackages].sort());

		const catalog = commands.find(command => command.label === "packages/catalog");
		const isolatedCatalog = commands.find(command => command.label === "packages/catalog (isolated)");
		const expensiveCatalogFiles = [
			"test/a-reference-lookup-parses-only-the-models-it-reaches.test.ts",
			"test/classifying-a-model-id-retains-nothing.test.ts",
			"test/a-resolved-model-keeps-the-compat-its-sources-declared.test.ts",
		];
		expect(catalog).toBeDefined();
		expect(isolatedCatalog).toBeDefined();
		const ignoredCatalogFiles = catalog?.command.flatMap((argument, index, command) =>
			argument === "--path-ignore-patterns" ? [command[index + 1]] : [],
		);
		expect(ignoredCatalogFiles).toEqual(expensiveCatalogFiles);
		expect(isolatedCatalog?.command.slice(-expensiveCatalogFiles.length)).toEqual(expensiveCatalogFiles);
		expect(isolatedCatalog?.command).toContain("--parallel=1");

		const utils = commands.find(command => command.label === "packages/utils");
		const ignoredUtilsFiles = utils?.command.flatMap((argument, index, command) =>
			argument === "--path-ignore-patterns" ? [command[index + 1]] : [],
		);
		expect(ignoredUtilsFiles).toEqual(["test/slice-extract-fuzz.test.ts"]);
		expect(commands.find(command => command.label === "plugins/hashline")?.env).toEqual({ HASHLINE_SEED_SOAK: "1" });
	});

	it("runs every native package and isolates the engine fuzz suite", async () => {
		const commands = await commandsForMode("native");
		const ordinaryPackages = commands
			.filter(command => command.label !== "hosts/terminal/engine (isolated)")
			.map(command => command.label)
			.sort();
		expect(ordinaryPackages).toEqual([...nativeAndIntegrationPackages].sort());

		const engine = commands.find(command => command.label === "hosts/terminal/engine");
		const isolatedEngine = commands.find(command => command.label === "hosts/terminal/engine (isolated)");
		expect(engine).toBeDefined();
		expect(isolatedEngine).toBeDefined();
		const ignoredEngineFiles = engine?.command.flatMap((argument, index, command) =>
			argument === "--path-ignore-patterns" ? [command[index + 1]] : [],
		);
		expect(ignoredEngineFiles).toEqual(["test/editor-wordwrap-fuzz.test.ts"]);
		expect(isolatedEngine?.command.slice(-1)).toEqual(["test/editor-wordwrap-fuzz.test.ts"]);
		expect(isolatedEngine?.command).toContain("--parallel=1");
	});
});
