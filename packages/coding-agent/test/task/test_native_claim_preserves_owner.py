"""Defend native claim ownership across every CLI transition.

Replay the reported owner overwrite with a scratch version-2 ledger. These tests
cover the persisted claim union, stale identities and lifecycle transitions, not
installed WorkerBackend validation or production ledger contents.
"""
import copy
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest

BRIDGE = Path(__file__).resolve().parents[2] / "src/task/native-ledger-bridge.py"
AUTH = {"status": "authorized", "timestamp": "2026-01-01T00:00:00Z", "scope": "scratch", "authorized_by": "tester"}
RETRYABLE = {"version": 1, "state": "retryable", "worker_id": None, "run_id": None, "task_handle": None}


class NativeClaimOwner(unittest.TestCase):
    def setUp(self):
        self.scratch = tempfile.TemporaryDirectory()
        self.addCleanup(self.scratch.cleanup)
        self.ledger = Path(self.scratch.name) / "ledger.json"
        self.env = {**os.environ, "VEYYON_WORKFLOWS_DIR": str(Path(self.scratch.name) / "absent"), "PYTHONPATH": ""}
        self.seed({"owner": " person-1 ", "stage": "qa", "state": "pending", "prompt": "Verify scratch workflow", "authorization": AUTH})

    def seed(self, request):
        self.ledger.write_text(json.dumps({"version": 2, "requests": {"ticket": request}}), encoding="utf-8")

    def data(self):
        return json.loads(self.ledger.read_text(encoding="utf-8"))

    def run_bridge(self, command, *args):
        result = subprocess.run([sys.executable, str(BRIDGE), command, "--ledger", str(self.ledger), *args], env=self.env, cwd=BRIDGE.parent, capture_output=True, text=True, timeout=10)
        self.assertIn(result.returncode, (0, 1), result.stderr)
        return json.loads(result.stdout)

    def claim(self):
        result = self.run_bridge("claim", "--worker-id", "dispatcher")
        self.assertTrue(result["claimed"], result)
        return result["ticket"]["runId"]

    def dispatch(self, run):
        result = self.run_bridge("record-dispatch", "--state-dir", self.scratch.name, "--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://worker")
        self.assertTrue(result["recorded"], result)

    def active(self):
        run = self.claim()
        self.dispatch(run)
        return run

    def assert_accountable(self):
        data = self.data()
        self.assertEqual(data["version"], 2)
        self.assertEqual(data["requests"]["ticket"]["owner"], " person-1 ")
        self.assertEqual(data["requests"]["ticket"]["stage"], "qa")
        return data["requests"]["ticket"]

    def test_claim_dispatch_rollback_preserve_owner_and_allow_retry(self):
        run = self.claim()
        req = self.assert_accountable()
        self.assertEqual(req["native_claim"], {"version": 1, "state": "active", "worker_id": "dispatcher", "run_id": run, "task_handle": None})
        self.dispatch(run)
        self.assertEqual(self.assert_accountable()["native_claim"]["task_handle"], "agent://worker")
        result = self.run_bridge("rollback", "--ticket-id", "ticket", "--run-id", run, "--previous-state", "pending")
        self.assertTrue(result["rolled_back"])
        self.assertEqual(self.assert_accountable()["native_claim"], RETRYABLE)
        self.assertNotEqual(self.claim(), run)

    def test_recovery_keeps_live_claim_and_reclaims_only_absent_worker(self):
        self.active()
        before = self.ledger.read_bytes()
        self.assertEqual(self.run_bridge("recover", "--running-worker-ids", "worker")["recovered"], [])
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(self.run_bridge("recover")["recovered"], ["ticket"])
        req = self.assert_accountable()
        self.assertEqual(req["native_claim"], RETRYABLE)
        self.assertIn("Recovered orphaned claim", req["history"][-1]["reason"])
        self.claim()

    def test_success_and_failure_preserve_owner_and_clear_live_execution(self):
        for verdict, expected_state in [("pass", "QA"), ("fail", "implementation")]:
            with self.subTest(verdict=verdict):
                self.setUp()
                run = self.active()
                result = {"verdict": verdict, "stage": "build", "checks": [{"purpose": "verification", "exit_code": 0}]}
                out = self.run_bridge("complete", "--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://worker", "--result-json", json.dumps(result))
                self.assertTrue(out["completed"], out)
                self.assertEqual(out["ok"], verdict == "pass")
                req = self.assert_accountable()
                self.assertEqual(req["state"], expected_state)
                self.assertEqual(req["native_claim"], RETRYABLE)
                self.assertEqual(req["history"][-1]["actor"], "WorkerBackend")

    def test_stale_run_handle_and_duplicate_dispatch_do_not_change_ledger(self):
        run = self.active()
        for command, args in [
            ("record-dispatch", ["--state-dir", self.scratch.name, "--ticket-id", "ticket", "--run-id", "stale", "--task-handle", "agent://worker"]),
            ("record-dispatch", ["--state-dir", self.scratch.name, "--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://foreign"]),
            ("rollback", ["--ticket-id", "ticket", "--run-id", "stale", "--previous-state", "pending"]),
            ("complete", ["--ticket-id", "ticket", "--run-id", "stale", "--task-handle", "agent://worker"]),
            ("complete", ["--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://foreign"]),
        ]:
            with self.subTest(command=command, args=args):
                before = self.ledger.read_bytes()
                self.run_bridge(command, *args)
                self.assertEqual(self.ledger.read_bytes(), before)

    def test_malformed_claims_and_legacy_fields_fail_closed_in_every_transition(self):
        run = self.active()
        base = self.data()["requests"]["ticket"]
        active = base["native_claim"]
        variants = [None, {}, {**active, "version": 2}, {**active, "state": "unknown"},
                    {**RETRYABLE, "run_id": run}, {**active, "worker_id": "foreign"},
                    {**active, "worker_id": ""}, {**active, "run_id": ""}, {**active, "task_handle": ""}]
        variants += [{k: v for k, v in active.items() if k != omitted} for omitted in active]
        for claim in variants:
            with self.subTest(claim=claim):
                req = copy.deepcopy(base)
                req["native_claim"] = claim
                self.seed(req)
                before = self.ledger.read_bytes()
                for command, args in [
                    ("claim", []), ("recover", []),
                    ("record-dispatch", ["--state-dir", self.scratch.name, "--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://worker"]),
                    ("rollback", ["--ticket-id", "ticket", "--run-id", run, "--previous-state", "pending"]),
                    ("complete", ["--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://worker"]),
                ]:
                    self.run_bridge(command, *args)
                    self.assertEqual(self.ledger.read_bytes(), before)

    def test_pending_legacy_identities_and_undispatched_completions_fail_closed(self):
        run = self.claim()
        before = self.ledger.read_bytes()
        self.run_bridge("complete", "--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://worker")
        self.assertEqual(self.ledger.read_bytes(), before)
        base = self.data()["requests"]["ticket"]
        for legacy in ("native_run_id", "native_task_handle"):
            for value in ("old", 0, [], {}):
                with self.subTest(legacy=legacy, value=value):
                    self.seed({"state": "pending", "owner": "person-1", "authorization": AUTH, legacy: value})
                    before = self.ledger.read_bytes()
                    self.assertFalse(self.run_bridge("claim")["claimed"])
                    self.assertEqual(self.ledger.read_bytes(), before)
            self.seed({**base, legacy: "old"})
            before = self.ledger.read_bytes()
            self.run_bridge("record-dispatch", "--state-dir", self.scratch.name, "--ticket-id", "ticket", "--run-id", run, "--task-handle", "agent://worker")
            self.assertEqual(self.ledger.read_bytes(), before)

    def test_retryable_claim_refuses_a_delayed_old_completion_after_a_new_run(self):
        old_run = self.active()
        self.run_bridge("rollback", "--ticket-id", "ticket", "--run-id", old_run, "--previous-state", "pending")
        new_run = self.active()
        self.assertNotEqual(new_run, old_run)
        before = self.ledger.read_bytes()
        self.run_bridge("complete", "--ticket-id", "ticket", "--run-id", old_run, "--task-handle", "agent://worker")
        self.assertEqual(self.ledger.read_bytes(), before)
        self.assertEqual(self.assert_accountable()["native_claim"]["run_id"], new_run)

    def test_human_owned_in_progress_and_legacy_without_claim_stay_unchanged(self):
        for extra in [{}, {"native_run_id": "old"}, {"native_task_handle": "agent://old"}]:
            with self.subTest(extra=extra):
                self.seed({"state": "implementation", "owner": "human", "authorization": AUTH, **extra})
                before = self.ledger.read_bytes()
                self.assertFalse(self.run_bridge("claim")["claimed"])
                self.assertEqual(self.run_bridge("recover")["recovered"], [])
                self.assertEqual(self.ledger.read_bytes(), before)


if __name__ == "__main__":
    unittest.main(verbosity=2)
