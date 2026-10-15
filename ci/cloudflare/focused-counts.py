import pathlib
import re
import sys

label, filename, status = sys.argv[1:]
text = pathlib.Path(filename).read_text()
passes = re.findall(r"^\s*(\d+) pass\s*$", text, re.MULTILINE)
failures = re.findall(r"^\s*(\d+) fail\s*$", text, re.MULTILINE)
if len(passes) != 1 or len(failures) != 1:
    raise SystemExit(f"FOCUSED_SUMMARY_MISSING label={label} status={status}")
p, f = int(passes[0]), int(failures[0])
expected = 9 if label == "credential-block" else 1
print(f"FOCUSED_SUMMARY label={label} pass={p} fail={f} status={status}", flush=True)
if p + f != expected:
    raise SystemExit(f"Expected {expected} executed cases, observed {p + f}")
if f == 0 and (p == 0 or int(status) != 0):
    raise SystemExit("Runner status disagrees with positive passing summary")
# A red proof is expected to fail. Preserve the counts; branch policy checks them.
pathlib.Path(filename + ".counts").write_text(f"{p} {f}\n")
