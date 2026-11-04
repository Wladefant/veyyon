import { Database } from "bun:sqlite";
import { SecretIntakeBroker, type SecretIntakeContext } from "../../../src/secrets/intake-broker";

const [databasePath, requestId, secretRef] = process.argv.slice(2);
if (!databasePath || !requestId || !secretRef) process.exit(2);
const context: SecretIntakeContext = { ownerSessionId: "session-restart", projectId: "project-restart", actorId: "actor-restart" };
const database = new Database(databasePath);
const broker = new SecretIntakeBroker({
	database,
	vaultCollection: "synthetic-collection",
	context,
	allowedOperations: [{ tool: "synthetic-tool", purpose: "synthetic-purpose" }],
	vault: {
		async saveVerified() { throw new Error("unexpected vault access"); },
		async readVerified() { throw new Error("unexpected vault access"); },
	},
	protection: { async register() {}, async execute() { throw new Error("unexpected execution"); } },
});
try {
	const request = broker.get(context, requestId).request;
	let consumeRefused = false;
	try { await broker.consume(context, secretRef, { tool: "synthetic-tool", purpose: "synthetic-purpose" }); }
	catch { consumeRefused = true; }
	process.stdout.write(JSON.stringify({ status: request.status, consumeRefused }) + "\n");
} finally {
	broker.close();
	database.close();
}
