import datetime
import csv

now_utc = datetime.datetime.now(datetime.timezone.utc).isoformat()

rows = [
    ["ts", "phase", "decision", "why", "evidence", "result"],
    [
        now_utc,
        "intake",
        "Use isolated own branch",
        "retrospective record; event time not captured. Existing checkout contains foreign edits",
        "agent://AclStartup.AclPrep",
        "open",
    ],
    [
        now_utc,
        "measure",
        "Measure exact PowerShell verifier before changing timeout",
        "retrospective record; event time not captured. An icacls timing does not test the verifier",
        "C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/raw-timing.json",
        "INCONCLUSIVE",
    ],
    [
        now_utc,
        "design",
        "Reuse existing native verification candidate",
        "retrospective record; event time not captured. PR 933 already removes PowerShell cold starts",
        "https://github.com/Wladefant/veyyon/pull/933",
        "open",
    ],
    [
        now_utc,
        "isolation",
        "Do not bypass Windows test sandbox guard",
        "retrospective record; event time not captured. Existing supported sandbox executes Linux and skips Windows FFI",
        "scripts/test-sandbox/README.md:86",
        "open",
    ],
    [
        now_utc,
        "host-pressure",
        "Attribute CPU load correlation but classify exact 27.4s incident cause as inconclusive",
        "PowerShell startup overhead (p50 2.66s) and host CPU load correlate with latency. Instantaneous reading reached 100% but interval was 46.22% machine load (739.5% active sum across 16 cores), so sustained saturation is not proven. 15s timeout did not reproduce in harness (0/14 timed out; all finished in 2.68-3.81s)",
        "Sample 1: 2026-11-05T08:43:06.24Z, Sample 2: 2026-11-05T08:43:50.08Z (interval 43.85s); C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/host-pressure.json; C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/event-loop-lag-results.json",
        "INCONCLUSIVE",
    ],
    [
        now_utc,
        "evaluation",
        "KEEP native-over-PS verification candidate",
        "Native Bun process saves p50 2678.18 ms (p95 2978.23 ms) over PowerShell in 15 balanced pairs (complete 15/0/0, delta range 2439.66-2978.23 ms); in-process Win32 FFI executes in 88.6 us (p50), eliminating CLR startup bottleneck. No guarantee against extreme host scheduler contention",
        "C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/native-comparison-raw.json; C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/native-comparison-results.md",
        "KEEP",
    ],
    [
        now_utc,
        "probe",
        "Execute timestamp probe on true OS exit vs JS promise resolve",
        "Win32 GetProcessTimes proves true OS exit takes 2.60-2.72s (script rundown 234-273ms); Bun promise resolve follows close event within 0.2-4.7ms in scratch runner. Limitation: independent probe cannot observe event-loop lag in the original incident caller process",
        "C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/true_exit_probe_results.json; C:/Users/wkiri/development/veyyon-wt/acl-startup-20261105/.acl-evidence/bun_timestamp_probe_results.json",
        "measured",
    ],
]

log_path = "C:/Users/wkiri/.veyyon/profiles/default/agent/sessions/-development-super-board/2026-09-15T19-56-43-199Z_01a0a6a4-a53f-77ae-b4f7-7fd68868fb45/local/decision-log-AclStartup.tsv"

with open(log_path, "w", encoding="utf-8", newline="") as f:
    writer = csv.writer(f, delimiter="\t")
    writer.writerows(rows)

print("Updated decision log with UTC timestamp:", now_utc)
print("Total rows:", len(rows))
