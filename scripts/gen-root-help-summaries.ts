/**
 * Regenerate root-help summaries in `packages/coding-agent/src/cli-commands.ts`
 * from the loaded command class statics (`description`, `hidden`, `devTool`).
 *
 * Why this exists: `veyyon --help` renders its command listing directly from
 * each entry's `summary` metadata in `cli-commands.ts` without loading the full
 * command module graphs. When a command's static description changes, the
 * static summary in `cli-commands.ts` must be kept in sync. This script
 * programmatically updates those summaries directly from loaded class statics.
 *
 * Run: bun scripts/gen-root-help-summaries.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const CLI_COMMANDS_PATH = path.join(REPO_ROOT, "packages", "coding-agent", "src", "cli-commands.ts");
const COMMANDS_DIR = path.join(REPO_ROOT, "packages", "coding-agent", "src", "commands");
const APP_NAME = "veyyon";

interface CommandStaticMetadata {
	description: string;
	hidden: boolean;
	devTool: boolean;
}

function extractCommandStatics(filePath: string): CommandStaticMetadata {
	const content = fs.readFileSync(filePath, "utf8");

	let description = "";
	const descMatch = content.match(/static\s+description\s*=\s*(?:(["'])([\s\S]*?)\1|`([\s\S]*?)`);/);
	if (descMatch) {
		if (descMatch[2] !== undefined) {
			description = descMatch[2].replace(/\s+/g, " ").trim();
		} else if (descMatch[3] !== undefined) {
			description = descMatch[3].replace(/\$\{APP_NAME\}/g, APP_NAME).replace(/\s+/g, " ").trim();
		}
	}

	const hiddenMatch = content.match(/static\s+hidden\s*=\s*(true|false);/);
	const hidden = hiddenMatch ? hiddenMatch[1] === "true" : false;

	const devToolMatch = content.match(/static\s+devTool\s*=\s*(true|false);/);
	const devTool = devToolMatch ? devToolMatch[1] === "true" : false;

	return { description, hidden, devTool };
}

function main(): void {
	let content = fs.readFileSync(CLI_COMMANDS_PATH, "utf8");
	const entryRegex =
		/(\{\s*name:\s*"([^"]+)",[\s\S]*?load:\s*\(\)\s*=>\s*import\("([^"]+)"\)[\s\S]*?)(summary:\s*\{[^}]*\})(,?)(\s*\})/g;

	const updates: string[] = [];

	content = content.replace(
		entryRegex,
		(
			match: string,
			prefix: string,
			name: string,
			importPath: string,
			summaryBlock: string,
			comma: string,
			suffix: string,
		): string => {
			const relativeTarget = importPath.startsWith("./commands/")
				? importPath.slice("./commands/".length)
				: importPath;
			const commandFile = path.join(COMMANDS_DIR, `${relativeTarget}.ts`);

			if (!fs.existsSync(commandFile)) {
				return match;
			}

			const statics = extractCommandStatics(commandFile);

			const currentDescMatch = summaryBlock.match(/description:\s*(["'])([\s\S]*?)\1/);
			const currentHiddenMatch = summaryBlock.match(/hidden:\s*(true|false)/);
			const currentDevToolMatch = summaryBlock.match(/devTool:\s*(true|false)/);

			const currentDesc = currentDescMatch ? currentDescMatch[2] : "";
			const currentHidden = currentHiddenMatch ? currentHiddenMatch[1] === "true" : false;
			const currentDevTool = currentDevToolMatch ? currentDevToolMatch[1] === "true" : false;

			const trailingComma = comma || ",";
			const hasDrift =
				currentDesc !== statics.description ||
				currentHidden !== statics.hidden ||
				currentDevTool !== statics.devTool ||
				comma !== ",";

			if (!hasDrift) {
				return match;
			}

			const fields: string[] = [];
			fields.push(`description: ${JSON.stringify(statics.description)}`);
			if (statics.hidden) {
				fields.push("hidden: true");
			}
			if (statics.devTool) {
				fields.push("devTool: true");
			}

			const newSummaryBlock = `summary: { ${fields.join(", ")} }`;
			updates.push(
				`${name}: description ${JSON.stringify(currentDesc)} -> ${JSON.stringify(statics.description)}`,
			);

			return `${prefix}${newSummaryBlock}${trailingComma}${suffix}`;
		},
	);

	if (updates.length > 0) {
		fs.writeFileSync(CLI_COMMANDS_PATH, content, "utf8");
		process.stdout.write(
			`Regenerated ${updates.length} command summaries in ${path.relative(REPO_ROOT, CLI_COMMANDS_PATH)}:\n`,
		);
		for (const u of updates) {
			process.stdout.write(`  ${u}\n`);
		}
	} else {
		process.stdout.write("All command summaries in cli-commands.ts are already up to date with class statics.\n");
	}
}

main();
