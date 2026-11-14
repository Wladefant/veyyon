import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	HEARTBEAT_INTERVAL_MS,
	heartbeatDir,
	type HeartbeatParticipant,
	type HeartbeatResourceSample,
	joinHeartbeat,
	MAX_RESOURCE_SAMPLES,
	reportSilentDeaths,
	type SessionHeartbeat,
	type SessionPhase,
	_flushHeartbeatForTest,
	_resetHeartbeatStateForTest,
	_setConsoleCtrlHandlerForTest,
} from "../src/session-heartbeat";
import { type MemoryLimits, readMemoryLimits } from "../src/commit-memory";

describe("session-heartbeat history, handleCount, and console recorder", () => {
	beforeEach(() => {
		_resetHeartbeatStateForTest();
	});

	afterEach(() => {
		_resetHeartbeatStateForTest();
	});

	function makeParticipant(id = "test-session-1", initialPhase: SessionPhase = "idle"): {
		participant: HeartbeatParticipant;
		setPhase: (p: SessionPhase) => void;
	} {
		let currentPhase = initialPhase;
		return {
			participant: {
				sessionId: () => id,
				phase: () => currentPhase,
				spawned: false,
			},
			setPhase: (p: SessionPhase) => {
				currentPhase = p;
			},
		};
	}

	function readHeartbeatFile(pid = process.pid): SessionHeartbeat | undefined {
		const filePath = path.join(heartbeatDir(), `${pid}.json`);
		if (!fs.existsSync(filePath)) return undefined;
		return JSON.parse(fs.readFileSync(filePath, "utf8")) as SessionHeartbeat;
	}

	it("exports MAX_RESOURCE_SAMPLES as 12", () => {
		expect(MAX_RESOURCE_SAMPLES).toBe(12);
	});

	it("integrates native console control handler on first join and removes safely on leave", async () => {
		let installCalledWith: string | undefined;
		let removeCalled = false;

		_setConsoleCtrlHandlerForTest(
			(logPath: string) => {
				installCalledWith = logPath;
				return { installed: true, supported: true, path: logPath, status: "installed" };
			},
			() => {
				removeCalled = true;
				return true;
			},
		);

		const { participant } = makeParticipant();
		const handle = joinHeartbeat(participant);

		await _flushHeartbeatForTest();

		expect(installCalledWith).toBeDefined();
		expect(installCalledWith).toContain(`${process.pid}.console.log`);

		const beat = readHeartbeatFile();
		expect(beat).toBeDefined();
		expect(beat?.consoleCtrlInstalled).toBe(true);
		expect(beat?.consoleCtrlStatus).toBe("installed");
		expect(beat?.consoleLogPath).toBe(installCalledWith);

		// Second participant joins - should NOT reinstall
		let secondInstallCalled = false;
		_setConsoleCtrlHandlerForTest(
			() => {
				secondInstallCalled = true;
				return { installed: true, supported: true, status: "reinstalled" };
			},
			() => {
				removeCalled = true;
				return true;
			},
		);

		const second = makeParticipant("test-session-2");
		const secondHandle = joinHeartbeat(second.participant);
		expect(secondInstallCalled).toBe(false);

		// First leaves - second is still active, so removal should NOT be called yet
		handle.leave();
		expect(removeCalled).toBe(false);

		// Last participant leaves - removal SHOULD be called
		secondHandle.leave();
		expect(removeCalled).toBe(true);
	});

	it("catches console control handler failure without breaking session", async () => {
		_setConsoleCtrlHandlerForTest(
			() => {
				throw new Error("Simulated native binding crash");
			},
			() => false,
		);

		const { participant } = makeParticipant();
		// Must not throw:
		const handle = joinHeartbeat(participant);
		await _flushHeartbeatForTest();

		const beat = readHeartbeatFile();
		expect(beat).toBeDefined();
		expect(beat?.consoleCtrlInstalled).toBe(false);
		expect(beat?.consoleCtrlStatus).toBe("unavailable");

		handle.leave();
	});

	it("records unsupported console control handler status gracefully", async () => {
		_setConsoleCtrlHandlerForTest(
			() => ({
				installed: false,
				supported: false,
				status: "unsupported_platform",
			}),
			() => false,
		);

		const { participant } = makeParticipant();
		const handle = joinHeartbeat(participant);
		await _flushHeartbeatForTest();

		const beat = readHeartbeatFile();
		expect(beat).toBeDefined();
		expect(beat?.consoleCtrlInstalled).toBe(false);
		expect(beat?.consoleCtrlStatus).toBe("unsupported_platform");

		handle.leave();
	});

	it("retains latest reading during rapid phase burst without erasing history", async () => {
		_setConsoleCtrlHandlerForTest(
			logPath => ({ installed: true, supported: true, path: logPath, status: "installed" }),
			() => true,
		);

		const { participant, setPhase } = makeParticipant();
		const handle = joinHeartbeat(participant);
		await _flushHeartbeatForTest();

		// Rapid phase transitions within the same interval
		const phases: SessionPhase[] = ["provider", "tool", "compaction", "idle"];
		for (let i = 0; i < 20; i++) {
			setPhase(phases[i % phases.length]);
			handle.update();
			await _flushHeartbeatForTest();
		}

		const beat = readHeartbeatFile();
		expect(beat).toBeDefined();
		expect(beat?.resourceHistory).toBeDefined();
		expect(beat!.resourceHistory!.length).toBe(1);

		handle.leave();
	});

	it("accumulates periodic snapshots over time and bounds to at most 12", async () => {
		_setConsoleCtrlHandlerForTest(
			logPath => ({ installed: true, supported: true, path: logPath, status: "installed" }),
			() => true,
		);

		let mockTime = 1_700_000_000_000;
		const origDateNow = Date.now;
		const origDate = globalThis.Date;

		Date.now = () => mockTime;
		// @ts-expect-error Mock Date constructor for ISO string generation
		globalThis.Date = class extends origDate {
			constructor(...args: unknown[]) {
				if (args.length === 0) {
					super(mockTime);
				} else {
					// @ts-expect-error forward args
					super(...args);
				}
			}
			static now() {
				return mockTime;
			}
			static parse(s: string) {
				return origDate.parse(s);
			}
		};

		try {
			const { participant, setPhase } = makeParticipant();
			const handle = joinHeartbeat(participant);
			await _flushHeartbeatForTest();

			for (let i = 0; i < 20; i++) {
				mockTime += HEARTBEAT_INTERVAL_MS;
				setPhase(i % 2 === 0 ? "tool" : "provider");
				handle.update();
				await _flushHeartbeatForTest();
			}

			const beat = readHeartbeatFile();
			expect(beat).toBeDefined();
			expect(beat?.resourceHistory).toBeDefined();
			expect(Array.isArray(beat?.resourceHistory)).toBe(true);
			expect(beat!.resourceHistory!.length).toBe(MAX_RESOURCE_SAMPLES);

			const lastSample = beat!.resourceHistory![beat!.resourceHistory!.length - 1];
			expect(lastSample.at).toBeDefined();
			expect(typeof lastSample.rssBytes).toBe("number");
			expect(lastSample.rssBytes).toBeGreaterThan(0);

			handle.leave();
		} finally {
			Date.now = origDateNow;
			globalThis.Date = origDate;
		}
	});

	it("survives serialization and readHeartbeat/reportSilentDeaths correctly", async () => {
		_setConsoleCtrlHandlerForTest(
			logPath => ({ installed: true, supported: true, path: logPath, status: "installed" }),
			() => true,
		);

		const { participant } = makeParticipant("dead-session");
		const handle = joinHeartbeat(participant);
		await _flushHeartbeatForTest();

		const beat = readHeartbeatFile();
		expect(beat).toBeDefined();
		expect(beat?.resourceHistory).toBeDefined();
		expect(beat?.consoleCtrlStatus).toBe("installed");

		// Simulate process death: participant did not call handle.leave(),
		// so heartbeat file remains. Now call reportSilentDeaths() for a non-alive pid.
		const fakePid = 999999;
		const fakePath = path.join(heartbeatDir(), `${fakePid}.json`);
		const fakeBeat: SessionHeartbeat = {
			...beat!,
			pid: fakePid,
			startIdentity: "fake-start-identity",
			sessionId: "dead-session-999999",
			handleCount: 42,
		};
		fs.writeFileSync(fakePath, `${JSON.stringify(fakeBeat)}\n`);

		const dead = reportSilentDeaths();
		const reported = dead.find(d => d.pid === fakePid);
		expect(reported).toBeDefined();
		expect(reported?.handleCount).toBe(42);
		expect(reported?.consoleCtrlStatus).toBe("installed");
		expect(reported?.consoleLogPath).toBeDefined();
		expect(reported?.resourceHistory).toBeDefined();

		handle.leave();
	});
});
