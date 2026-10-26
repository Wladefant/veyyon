"""Behavioral tests for account cache-rate analysis."""

from __future__ import annotations

import json
import tempfile
import unittest
from pathlib import Path

from common.cache_rates import analyze_sessions


def record(ts: str | int | float, *, model: str = "model-a", provider: str = "provider-a",
           read: int = 0, write: int = 0, input_tokens: int = 0, account: str | None = "acct-a",
           transport: str = "websocket", event: str | None = None,
           stop_reason: str | None = None) -> dict:
    if event:
        return {"timestamp": ts, "type": event}
    usage = {"input": input_tokens, "cacheRead": read, "cacheWrite": write,
             "transport": transport, "model": model}
    if account is not None:
        usage["credentialId"] = account
    message = {"role": "assistant", "model": model, "provider": provider, "usage": usage}
    if stop_reason is not None:
        message["stopReason"] = stop_reason
    return {"timestamp": ts, "message": message}


class CacheRatesTest(unittest.TestCase):
    def analyze(self, entries: list[dict], since: str = "2026-01-01T00:00:00Z",
                until: str = "2026-01-02T00:00:00Z") -> dict:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "session.jsonl"
            path.write_text("\n".join(json.dumps(item) for item in entries) + "\n", encoding="utf-8")
            return analyze_sessions([path], since, until)

    def test_weighted_cache_rate_and_inclusive_window_bounds(self) -> None:
        data = self.analyze([
            record("2026-01-01T00:00:00Z", input_tokens=100, read=100),
            record("2026-01-01T12:00:00Z", input_tokens=900),
            record("2026-01-02T00:00:00Z", input_tokens=100, read=100),
            record("2025-12-31T23:59:59Z", input_tokens=9999, read=9999),
        ])
        self.assertEqual(data["totals"]["input"], 1100)
        self.assertEqual(data["totals"]["cacheRead"], 200)
        self.assertAlmostEqual(data["cacheHitRate"], 200 / 1300)

    def test_legacy_model_fallback_unknown_account(self) -> None:
        legacy = record("2026-01-01T00:00:00Z", account=None, model="legacy", read=10, input_tokens=10)
        legacy["message"]["usage"] = {"cacheRead": 10, "input": 10}
        data = self.analyze([legacy])
        self.assertEqual(data["accounts"]["unknown"]["messages"], 1)
        self.assertEqual(data["models"]["legacy"]["messages"], 1)

    def test_actual_custom_type_invalidates_cold_continuity(self) -> None:
        data = self.analyze([
            record("2026-01-01T00:00:00Z", read=40_000),
            {"timestamp": "2026-01-01T00:00:30Z", "customType": "prompt_cache_invalidated"},
            record("2026-01-01T00:01:00Z", read=0),
        ])
        self.assertEqual(data["coldMisses"]["eligible"], 0)

    def test_error_and_abort_turns_reset_cold_continuity(self) -> None:
        entries = [record("2026-01-01T00:00:00Z", read=40_000)]
        for minute, reason in ((1, "error"), (4, "aborted")):
            entries.extend([
                record(f"2026-01-01T00:0{minute}:00Z", read=1, stop_reason=reason),
                record(f"2026-01-01T00:0{minute + 1}:00Z", read=0),
                record(f"2026-01-01T00:0{minute + 2}:00Z", read=40_000),
            ])
        data = self.analyze(entries)
        self.assertEqual(data["coldMisses"]["eligible"], 0)
        self.assertEqual(data["coldMisses"]["count"], 0)

    def test_numeric_timestamps_are_milliseconds(self) -> None:
        data = self.analyze([
            record(1767225600000, input_tokens=10, read=10),
            record(1767225660000, input_tokens=20, read=20),
        ])
        self.assertEqual(data["totals"]["messages"], 2)
        self.assertEqual(data["totals"]["input"], 30)

    def test_provider_change_breaks_cold_continuity(self) -> None:
        data = self.analyze([
            record("2026-01-01T00:00:00Z", read=40_000, provider="provider-a"),
            record("2026-01-01T00:01:00Z", read=0, provider="provider-b"),
        ])
        self.assertEqual(data["coldMisses"]["eligible"], 0)

    def test_missing_session_file_is_an_error(self) -> None:
        with self.assertRaises(FileNotFoundError):
            analyze_sessions([Path("missing-session.jsonl")], "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")

    def test_sessions_do_not_share_cold_continuity(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            first, second = Path(tmp) / "first.jsonl", Path(tmp) / "second.jsonl"
            first.write_text(json.dumps(record("2026-01-01T00:00:00Z", read=40_000)) + "\n", encoding="utf-8")
            second.write_text(json.dumps(record("2026-01-01T00:01:00Z", read=0)) + "\n", encoding="utf-8")
            self.assertEqual(analyze_sessions([first, second], "2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z")["coldMisses"]["eligible"], 0)

    def test_cold_miss_rate_uses_per_account_eligible_denominator(self) -> None:
        data = self.analyze([
            record("2026-01-01T00:00:00Z", read=40_000, account="acct-a"),
            record("2026-01-01T00:01:00Z", read=0, account="acct-b"),
            record("2026-01-01T00:02:00Z", read=40_000, account="acct-b"),
            record("2026-01-01T00:03:00Z", read=0, account="acct-b"),
        ])
        self.assertEqual(data["accounts"]["acct-a"]["coldEligible"], 0)
        self.assertEqual(data["accounts"]["acct-a"]["coldMissRate"], 0.0)
        self.assertEqual(data["accounts"]["acct-b"]["coldEligible"], 2)
        self.assertEqual(data["accounts"]["acct-b"]["coldMissRate"], 1.0)

if __name__ == "__main__":
    unittest.main()
