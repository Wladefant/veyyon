import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const statePath = join(process.cwd(), "state.json");
const auditPath = join(process.cwd(), "audit.jsonl");
const state = JSON.parse(await readFile(statePath, "utf8"));
const args = process.argv.slice(2);
const record = async event => appendFile(auditPath, `${JSON.stringify(event)}\n`);
const emit = value => process.stdout.write(`${JSON.stringify(value)}\n`);
const fail = async () => { process.exitCode = 17; };

if (args[0] === "get" && args[1] === "org-collection") {
	if (state.wrongCollection) emit({ id: "wrong-collection", name: "Synthetic collection", organizationId: "org-synthetic" });
	else emit({ id: "collection-synthetic", name: "Synthetic collection", organizationId: "org-synthetic" });
} else if (args[0] === "list" && args[1] === "items") {
	await record({ command: "list" });
	if (state.listFails) await fail();
	else emit(state.items);
} else if (args[0] === "get" && args[1] === "item") {
	const item = state.items.find(candidate => candidate.id === args[2]);
	if (!item) await fail();
	else emit(state.badReadId ? { ...item, id: "unexpected-item" } : item);
} else if (args[0] === "create" && args[1] === "item") {
	const chunks = [];
	for await (const chunk of process.stdin) chunks.push(chunk);
	const input = Buffer.concat(chunks).toString("utf8");
	const payload = JSON.parse(Buffer.from(input.trim(), "base64").toString("utf8"));
	const payloadHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))).toString("hex");
	const secretHash = Buffer.from(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(payload.notes))).toString("hex");
	const encodedPayload = Buffer.from(input, "utf8").toString("base64");
	await record({ command: "create", argvHasPayload: args.includes(encodedPayload), hasManualVaultDirectory: process.env.BITWARDENCLI_APPDATA_DIR !== undefined, hasManualSession: process.env.BW_SESSION !== undefined, payloadHash, secretHash });
	const created = { ...payload, id: "item-synthetic" };
	if (!state.loseCreateOutput) {
		state.items.push(created);
		await writeFile(statePath, JSON.stringify(state));
		emit({ id: created.id });
	} else {
		state.items.push(created);
		await writeFile(statePath, JSON.stringify(state));
	}
} else {
	await fail();
}
