"""Aggregate cache rates and cold-cache misses from session JSONL without printing content."""

from __future__ import annotations

import argparse
import json
from collections import defaultdict
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable


def _time(value: str) -> datetime:
    parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        raise ValueError(f"Timestamp must include a timezone: {value!r}")
    return parsed.astimezone(timezone.utc)


def _tokens(usage: dict[str, Any], key: str) -> int:
    try:
        return max(0, int(usage.get(key, 0) or 0))
    except (TypeError, ValueError):
        return 0


def _timestamp(entry: dict[str, Any], message: dict[str, Any]) -> datetime | None:
    value = entry.get("timestamp", message.get("timestamp"))
    if isinstance(value, (int, float)):
        try:
            return datetime.fromtimestamp(value / 1000, timezone.utc)
        except (ValueError, OverflowError, OSError):
            return None
    if not isinstance(value, str):
        return None
    try:
        return _time(value)
    except ValueError:
        return None


def _invalidates_cache(entry: dict[str, Any]) -> bool:
    marker = " ".join(str(entry.get(k, "")) for k in ("type", "event", "kind", "customType")).lower()
    return any(term in marker for term in ("compact", "invalidat", "cache_reset", "cache-reset"))


def analyze_sessions(paths: Iterable[Path | str], since: str, until: str) -> dict[str, Any]:
    start, end = _time(since), _time(until)
    if start > end:
        raise ValueError("--since must not be later than --until")
    totals = {"input": 0, "cacheRead": 0, "cacheWrite": 0, "messages": 0}
    accounts: dict[str, dict[str, Any]] = defaultdict(lambda: {"input": 0, "cacheRead": 0, "cacheWrite": 0, "messages": 0, "coldMisses": 0, "coldEligible": 0})
    models: dict[str, dict[str, int]] = defaultdict(lambda: {"input": 0, "cacheRead": 0, "cacheWrite": 0, "messages": 0})
    transports: dict[str, dict[str, int]] = defaultdict(lambda: {"input": 0, "cacheRead": 0, "cacheWrite": 0, "messages": 0})
    eligible = cold = 0

    for raw_path in paths:
        lines = Path(raw_path).read_text(encoding="utf-8", errors="replace").splitlines()
        previous: tuple[str, int] | None = None
        for line in lines:
            try:
                entry = json.loads(line)
            except (json.JSONDecodeError, TypeError):
                continue
            if not isinstance(entry, dict):
                continue
            if _invalidates_cache(entry):
                previous = None
                continue
            message = entry.get("message")
            if not isinstance(message, dict) or message.get("role") != "assistant":
                continue
            if message.get("stopReason") in ("error", "aborted"):
                previous = None
                continue
            usage = message.get("usage")
            usage = usage if isinstance(usage, dict) else {}
            timestamp = _timestamp(entry, message)
            model = usage.get("model") or message.get("model") or "unknown"
            model = model if isinstance(model, str) and model else "unknown"
            identity = f"{message.get('provider', 'unknown')}:{model}"
            if previous is not None and previous[0] != identity:
                previous = None
            account = usage.get("credentialId")
            account = account if isinstance(account, str) and account else "unknown"
            transport = usage.get("transport")
            transport = transport if isinstance(transport, str) and transport else "unknown"
            cache_read = _tokens(usage, "cacheRead")
            cache_write = _tokens(usage, "cacheWrite")
            input_tokens = _tokens(usage, "input")
            if timestamp is None:
                previous = None
                continue
            if start <= timestamp <= end:
                if previous is not None and previous[0] == identity and previous[1] > 30_000:
                    eligible += 1
                    accounts[account]["coldEligible"] += 1
                    if cache_read < previous[1] / 2:
                        cold += 1
                        accounts[account]["coldMisses"] += 1
                totals["messages"] += 1
                totals["input"] += input_tokens
                totals["cacheRead"] += cache_read
                totals["cacheWrite"] += cache_write
                for grouping in (accounts[account], models[model], transports[transport]):
                    grouping["messages"] += 1
                    grouping["input"] += input_tokens
                    grouping["cacheRead"] += cache_read
                    grouping["cacheWrite"] += cache_write
            previous = (identity, cache_read)

    denominator = totals["input"] + totals["cacheRead"] + totals["cacheWrite"]
    for groups in (accounts, models, transports):
        for values in groups.values():
            group_denominator = values["input"] + values["cacheRead"] + values["cacheWrite"]
            values["cacheHitRate"] = values["cacheRead"] / group_denominator if group_denominator else 0.0
    for values in accounts.values():
        values["coldMissRate"] = values["coldMisses"] / values["coldEligible"] if values["coldEligible"] else 0.0
    return {
        "since": start.isoformat().replace("+00:00", "Z"),
        "until": end.isoformat().replace("+00:00", "Z"),
        "totals": totals,
        "cacheHitRate": totals["cacheRead"] / denominator if denominator else 0.0,
        "coldMisses": {"eligible": eligible, "count": cold, "rate": cold / eligible if eligible else 0.0},
        "accounts": dict(accounts),
        "models": dict(models),
        "transports": dict(transports),
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--since", required=True, help="Inclusive ISO-8601 start time")
    parser.add_argument("--until", required=True, help="Inclusive ISO-8601 end time")
    parser.add_argument("sessions", nargs="+", type=Path, help="Session JSONL path(s)")
    args = parser.parse_args()
    print(json.dumps(analyze_sessions(args.sessions, args.since, args.until), indent=2, sort_keys=True))


if __name__ == "__main__":
    main()
