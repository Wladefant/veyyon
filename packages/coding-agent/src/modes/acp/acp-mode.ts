import * as stream from "node:stream";
import { AgentSideConnection, ndJsonStream, type Stream } from "@agentclientprotocol/sdk";
import type { RuntimeMCPConfig } from "../../mcp/runtime-config";
import type { AgentSession } from "../../session/agent-session";
import { AcpAgent } from "./acp-agent";

export type AcpSessionFactory = (cwd: string) => Promise<AgentSession>;

export function createAcpConnection(
	transport: Stream,
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
	runtimeMCPConfig?: RuntimeMCPConfig,
): AgentSideConnection {
	return new AgentSideConnection(conn => new AcpAgent(conn, createSession, initialSession, runtimeMCPConfig), transport);
}

export async function runAcpMode(
	createSession: AcpSessionFactory,
	initialSession?: AgentSession,
	runtimeMCPConfig?: RuntimeMCPConfig,
): Promise<never> {
	// Humans who run `veyyon acp` by hand see a silent process and assume it is
	// broken (stdout is the JSON-RPC transport, so nothing may be printed
	// there). When stdin is a TTY no ACP client is attached — say so on stderr
	// before the transport starts.
	if (process.stdin.isTTY) {
		process.stderr.write(
			"veyyon acp: ACP server speaking JSON-RPC over stdio.\n" +
				'This command is meant to be spawned by an ACP client (e.g. Zed\'s "agent_servers" config), not run directly.\n' +
				"Waiting for protocol frames on stdin; logs: ~/.veyyon/profiles/<name>/logs/\n",
		);
	}
	const input = stream.Writable.toWeb(process.stdout);
	const output = stream.Readable.toWeb(process.stdin);
	const transport = ndJsonStream(input, output);
	const connection = createAcpConnection(transport, createSession, initialSession, runtimeMCPConfig);
	await connection.closed;
	process.exit(0);
}
