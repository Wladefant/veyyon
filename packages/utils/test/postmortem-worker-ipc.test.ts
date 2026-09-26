import { describe, expect, it } from "bun:test";
import * as postmortem from "../src/postmortem";

describe("postmortem.isWorkerIpcDeserializeError", () => {
	it("matches TypeError with message 'Unable to deserialize data.' and no stack, code, or syscall", () => {
		const err = new TypeError("Unable to deserialize data.");
		Reflect.deleteProperty(err, "stack");
		expect(postmortem.isWorkerIpcDeserializeError(err)).toBe(true);
	});

	it("does not match TypeError with a stack trace (application-thrown)", () => {
		const err = new TypeError("Unable to deserialize data.");
		expect(Boolean(err.stack)).toBe(true);
		expect(postmortem.isWorkerIpcDeserializeError(err)).toBe(false);
	});

	it("does not match TypeError with a code property", () => {
		const err = new TypeError("Unable to deserialize data.");
		Reflect.deleteProperty(err, "stack");
		Object.assign(err, { code: "ERR_IPC_DESERIALIZE" });
		expect(postmortem.isWorkerIpcDeserializeError(err)).toBe(false);
	});

	it("does not match TypeError with a syscall property", () => {
		const err = new TypeError("Unable to deserialize data.");
		Reflect.deleteProperty(err, "stack");
		Object.assign(err, { syscall: "ipc" });
		expect(postmortem.isWorkerIpcDeserializeError(err)).toBe(false);
	});

	it("does not match TypeError with a different message", () => {
		const err = new TypeError("Cannot read properties of undefined");
		Reflect.deleteProperty(err, "stack");
		expect(postmortem.isWorkerIpcDeserializeError(err)).toBe(false);
	});

	it("does not match standard Error with matching message and no stack", () => {
		const err = new Error("Unable to deserialize data.");
		Reflect.deleteProperty(err, "stack");
		expect(postmortem.isWorkerIpcDeserializeError(err)).toBe(false);
	});

	it("does not match plain object with message property", () => {
		expect(postmortem.isWorkerIpcDeserializeError({ message: "Unable to deserialize data." })).toBe(false);
	});

	it("does not match null or undefined", () => {
		expect(postmortem.isWorkerIpcDeserializeError(null)).toBe(false);
		expect(postmortem.isWorkerIpcDeserializeError(undefined)).toBe(false);
	});
});
