import { describe, expect, it } from "bun:test";
import { PYTHON_PRELUDE } from "../prelude";

const pythonPath = Bun.env.PYTHON ?? "python3";

async function runPrelude(
	code: string,
	env: Record<string, string> = {},
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__veyyon_display = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	const proc = Bun.spawn([pythonPath, "-c", script], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, ...env },
	});
	const [stdout, stderr, exitCode] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { stdout, stderr, exitCode };
}

describe("python prelude", () => {
	it("exposes read(path, offset?, limit?) with positional optional args", () => {
		// The eval docs advertise `read(path, offset?=1, limit?=None)`. A
		// keyword-only signature (`def read(path, *, offset=1, limit=None)`)
		// makes `read("file", 10)` raise `TypeError: read() takes 1 positional
		// argument but 2 were given`, which agents in the wild repeatedly hit.
		// Lock the contract so the helper accepts both positional and keyword
		// forms.
		const match = PYTHON_PRELUDE.match(/def\s+read\(([^)]+)\)/);
		expect(match).not.toBeNull();
		const signature = match?.[1] ?? "";
		expect(signature).not.toContain("*,");
		expect(signature).toContain("offset");
		expect(signature).toContain("limit");
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(
				[`print(read("artifact://21", 3, 2))`, `print(read("mcp://server/resource", 10, 5))`].join("\n"),
				{
					VEYYON_TOOL_BRIDGE_URL: server.url.toString(),
					VEYYON_TOOL_BRIDGE_TOKEN: "test-token",
					VEYYON_TOOL_BRIDGE_SESSION: "test-session",
				},
			);

			expect(result).toEqual({
				stdout: "resource contents\nresource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "artifact://21:3-4" },
				},
				{
					session: "test-session",
					run: null,
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	it("exposes isolation artifacts on the agent() handle node", () => {
		// agent(..., handle=True) is the only escape hatch for
		// recovering apply=False patch/branch/nested artifacts (the bare
		// schema return is just the parsed object), so the helper MUST
		// translate the bridge's camelCase details onto the node — otherwise
		// an isolated apply=False workflow loses captured nested patches.
		expect(PYTHON_PRELUDE).toContain('("patchPath", "patch_path")');
		expect(PYTHON_PRELUDE).toContain('("branchName", "branch_name")');
		expect(PYTHON_PRELUDE).toContain('("nestedPatches", "nested_patches")');
		expect(PYTHON_PRELUDE).toContain('("changesApplied", "changes_applied")');
		expect(PYTHON_PRELUDE).toContain('("isolationSummary", "isolation_summary")');
	});

	it("defs() lists variable names and type/shape only without leaking secret values or representations", async () => {
		const pythonCode = `
# Seeded arbitrary opaque secret strings
secret_token = "secret-token-opaque-xyz-98765"
api_key = "bearer-secret-token-key-4321"
empty_str = ""

# Nested collections containing secrets
nested_list = [
    "secret-list-item-alpha",
    {"secret-nested-dict-key": "secret-nested-dict-val"},
    ["secret-deep-item-1", "secret-deep-item-2"],
]
nested_dict = {
    "secret_key_1": "secret_val_1",
    "secret_key_2": ["secret_inner_val"],
}
secret_set = {"secret-set-item-alpha", "secret-set-item-beta"}
secret_tuple = ("secret-tuple-item-1", "secret-tuple-item-2", "secret-tuple-item-3")
empty_list = []
empty_dict = {}
empty_set = set()
empty_tuple = ()

# Function bodies containing secrets
def secret_worker():
    inner_secret = "secret-inside-function-body-999"
    return inner_secret

secret_lambda = lambda: "secret-inside-lambda-body-888"

# Objects with hostile repr / property hooks
class HostileReprLeak:
    def __repr__(self):
        return "SECRET-LEAK-VIA-REPR-12345"

class HostileReprError:
    def __repr__(self):
        raise RuntimeError("hostile __repr__ must not be executed")

class HostilePropertyHook:
    @property
    def dangerous_prop(self):
        raise RuntimeError("hostile property getter must not be executed")

hostile_leak = HostileReprLeak()
hostile_error = HostileReprError()
hostile_prop = HostilePropertyHook()

# Regular scalar types
scalar_int = 42
scalar_float = 3.14
scalar_bool = True
scalar_none = None

import json
print("__DEFS_JSON__=" + json.dumps(defs()))
`;

		const result = await runPrelude(pythonCode, {});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");

		const marker = "__DEFS_JSON__=";
		const jsonLine = result.stdout.split("\n").find(line => line.startsWith(marker));
		expect(jsonLine).toBeDefined();

		const entries = JSON.parse(jsonLine!.slice(marker.length)) as string[];

		// Assert output contains no secret substrings
		const secretSubstrings = [
			"secret-token-opaque-xyz-98765",
			"bearer-secret-token-key-4321",
			"secret-list-item-alpha",
			"secret-nested-dict-key",
			"secret-nested-dict-val",
			"secret-deep-item-1",
			"secret-deep-item-2",
			"secret_val_1",
			"secret_inner_val",
			"secret-set-item-alpha",
			"secret-set-item-beta",
			"secret-tuple-item-1",
			"secret-tuple-item-2",
			"secret-tuple-item-3",
			"secret-inside-function-body-999",
			"secret-inside-lambda-body-888",
			"SECRET-LEAK-VIA-REPR-12345",
		];

		const serializedOutput = JSON.stringify(entries);
		for (const secret of secretSubstrings) {
			expect(serializedOutput).not.toContain(secret);
			expect(result.stdout).not.toContain(secret);
		}

		// Assert output lists variable names and types/shapes only according to the contract:
		// Python _format_def will return type name, built-in collection lengths as type(n), function as function (no qualname).
		expect(entries).toContain("secret_token: str");
		expect(entries).toContain("api_key: str");
		expect(entries).toContain("empty_str: str");
		expect(entries).toContain("nested_list: list(3)");
		expect(entries).toContain("nested_dict: dict(2)");
		expect(entries).toContain("secret_set: set(2)");
		expect(entries).toContain("secret_tuple: tuple(3)");
		expect(entries).toContain("empty_list: list(0)");
		expect(entries).toContain("empty_dict: dict(0)");
		expect(entries).toContain("empty_set: set(0)");
		expect(entries).toContain("empty_tuple: tuple(0)");
		expect(entries).toContain("secret_worker: function");
		expect(entries).toContain("secret_lambda: function");
		expect(entries).toContain("hostile_leak: HostileReprLeak");
		expect(entries).toContain("hostile_error: HostileReprError");
		expect(entries).toContain("hostile_prop: HostilePropertyHook");
		expect(entries).toContain("scalar_int: int");
		expect(entries).toContain("scalar_float: float");
		expect(entries).toContain("scalar_bool: bool");
		expect(entries).toContain("scalar_none: NoneType");
	});

	it("env get/set emits status events excluding seeded opaque secret while returning actual value unchanged", async () => {
		const pythonCode = `
import json

events = []
_orig_emit = _emit_status
def _capturing_emit(op, **data):
    events.append({"op": op, **data})
    _orig_emit(op, **data)
_emit_status = _capturing_emit

secret_value = "seeded-opaque-env-secret-xyz-9876"
secret_key = "TEST_OPAQUE_SECRET_ENV_VAR"

set_ret = env(secret_key, secret_value)
get_ret = env(secret_key)

print("__ENV_EVENTS_JSON__=" + json.dumps(events))
print("__ENV_RETURN_JSON__=" + json.dumps({"set": set_ret, "get": get_ret}))
`;

		const result = await runPrelude(pythonCode, {});
		expect(result.exitCode).toBe(0);
		expect(result.stderr).toBe("");

		const secret = "seeded-opaque-env-secret-xyz-9876";

		const eventsMarker = "__ENV_EVENTS_JSON__=";
		const eventsLine = result.stdout.split("\n").find(line => line.startsWith(eventsMarker));
		expect(eventsLine).toBeDefined();
		const events = JSON.parse(eventsLine!.slice(eventsMarker.length)) as Array<Record<string, unknown>>;

		const returnMarker = "__ENV_RETURN_JSON__=";
		const returnLine = result.stdout.split("\n").find(line => line.startsWith(returnMarker));
		expect(returnLine).toBeDefined();
		const returns = JSON.parse(returnLine!.slice(returnMarker.length)) as { set: string; get: string };

		// Actual env returns unchanged
		expect(returns.set).toBe(secret);
		expect(returns.get).toBe(secret);

		// Captured status events exclude seeded opaque secret
		const serializedEvents = JSON.stringify(events);
		expect(serializedEvents).not.toContain(secret);

		// Status events preserve key and action metadata without value field
		const setEvent = events.find(e => e.op === "env" && e.action === "set");
		expect(setEvent).toBeDefined();
		expect(setEvent?.key).toBe("TEST_OPAQUE_SECRET_ENV_VAR");
		expect(setEvent?.value).toBe("<redacted>");

		const getEvent = events.find(e => e.op === "env" && e.action === "get");
		expect(getEvent).toBeDefined();
		expect(getEvent?.key).toBe("TEST_OPAQUE_SECRET_ENV_VAR");
		expect(getEvent?.value).toBe("<redacted>");
	});
});
