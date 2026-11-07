// WHY: Legacy SSE failures persisted malformed frame bytes and unattributable
// peer error messages. Real loopback streams cover both handshake states and
// pending-request rejection. This does not audit other transports or caller errors.
import { afterEach, describe, expect, it, type Mock, spyOn } from "bun:test";
import { once } from "node:events";
import { createServer, type ServerResponse } from "node:http";
import { LegacySseTransport } from "@veyyon/coding-agent/mcp/transports/sse";
import { logger } from "@veyyon/utils";

const marker = "FAKE_PRIVATE_LEGACY_SSE_FRAME";
afterEach(() => {
  // Each spy exists only for its test, including a failing regression run.
  debugSpy?.mockRestore();
  warnSpy?.mockRestore();
  debugSpy = undefined;
  warnSpy = undefined;
});
let debugSpy: Mock<typeof logger.debug> | undefined;
let warnSpy: Mock<typeof logger.warn> | undefined;

async function loopback(
  initial: string,
  answer: (request: { id: number | string }, stream: ServerResponse) => void,
) {
  let stream: ServerResponse | undefined;
  const server = createServer((request, response) => {
    if (request.method === "GET") {
      stream = response;
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write(initial);
      return;
    }
    let body = "";
    request.setEncoding("utf8");
    request.on("data", chunk => { body += chunk; });
    request.on("end", () => {
      response.writeHead(202).end();
      if (stream) answer(JSON.parse(body), stream);
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  await listening;
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Expected loopback TCP listener");
  const transport = new LegacySseTransport({
    type: "sse", url: `http://127.0.0.1:${address.port}/sse`, timeout: 1_500,
  });
  return {
    transport,
    async close() {
      await transport.close();
      const closed = once(server, "close");
      server.close();
      server.closeAllConnections();
      await closed;
    },
  };
}

const endpoint = "event: endpoint\ndata: /messages\n\n";
const malformed = `event: message\ndata: {${marker}\n\n`;

describe("legacy SSE private diagnostics", () => {
  it.each(["before endpoint", "after endpoint"])("omits malformed frame bytes %s", async phase => {
    debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
    const errors: string[] = [];
    const fixture = await loopback(
      phase === "before endpoint" ? malformed : endpoint,
      (_request, stream) => stream.write(malformed),
    );
    fixture.transport.onError = error => { errors.push(error.message); };
    try {
      const failure = phase === "before endpoint"
        ? fixture.transport.connect()
        : fixture.transport.connect().then(() => fixture.transport.request("tools/list"));
      const error = await failure.then(() => { throw new Error("Expected malformed SSE refusal"); }, error => error as Error);
      expect(error.message).toContain("not JSON");
      expect(error.message).toContain(fixture.transport.url);
      expect(error.message).not.toContain(marker);
      expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(marker);
      expect(errors.join("\n")).not.toContain(marker);
      if (phase === "after endpoint") expect(errors).toEqual([error.message]);
    } finally {
      await fixture.close();
    }
  });

  it("logs code and failed count without the unattributable peer message", async () => {
    warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
    const peerErrors: string[] = [];
    const fixture = await loopback(endpoint, (_request, stream) => {
      stream.write(`event: message\ndata: ${JSON.stringify({
        jsonrpc: "2.0", id: null, error: { code: -32700, message: marker },
      })}\n\n`);
    });
    fixture.transport.onError = error => { peerErrors.push(error.message); };
    try {
      await fixture.transport.connect();
      const error = await fixture.transport.request("tools/list").then(
        () => { throw new Error("Expected unattributable error refusal"); }, error => error as Error,
      );
      expect(error.message).toContain("-32700");
      expect(error.message).not.toContain("timed out");
      // The requested privacy boundary is persistent logs, not caller errors.
      expect(error.message).toContain(marker);
      expect(peerErrors.join("\n")).toContain(marker);
      const warning = warnSpy.mock.calls.find(call => call[0] === "MCP server reported an error it could not attribute to a request");
      expect(warning?.[1]).toEqual(expect.objectContaining({ code: -32700, failedRequests: 1 }));
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(marker);
    } finally {
      await fixture.close();
    }
  });

  it("still accepts a valid correlated response", async () => {
    const fixture = await loopback(endpoint, (request, stream) => {
      stream.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`);
    });
    try {
      await fixture.transport.connect();
      expect(await fixture.transport.request<{ tools: unknown[] }>("tools/list")).toEqual({ tools: [] });
    } finally {
      await fixture.close();
    }
  });
});
