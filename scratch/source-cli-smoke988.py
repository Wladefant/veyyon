import json, pathlib, subprocess, sys, time
import psutil
root = pathlib.Path(__file__).resolve().parents[1]
cmd = ["bun", "packages/coding-agent/src/cli.ts", "--print", "--model", "anthropic/claude-haiku-4-5-20251001", 'Run Python eval print(2+2), then bash echo hi, then bash exit 7; state exit code 7. Then search files for package.json, report results, and exit normally.']
def snapshot():
    result = {}
    for p in psutil.process_iter(['pid','ppid','name','cmdline','create_time']):
        try:
            info = p.info
            result[str(info['pid'])] = {k: info.get(k) for k in ('pid','ppid','name','cmdline','create_time')}
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            pass
    return result
before = snapshot()
started = time.time()
try:
    p = subprocess.run(cmd, cwd=str(root), capture_output=True, text=True, timeout=300, creationflags=subprocess.CREATE_NO_WINDOW)
    code = p.returncode
    stdout, stderr = p.stdout, p.stderr
except subprocess.TimeoutExpired as e:
    code = None
    stdout = e.stdout.decode(errors='replace') if isinstance(e.stdout, bytes) else (e.stdout or '')
    stderr = e.stderr.decode(errors='replace') if isinstance(e.stderr, bytes) else (e.stderr or '')
after = snapshot()
out = {"command": cmd, "cwd": str(root), "elapsed_seconds": round(time.time()-started, 3), "returncode": code, "stdout": stdout, "stderr": stderr, "new_pids": [after[k] for k in after.keys()-before.keys()], "missing_pids": sorted(before.keys()-after.keys()), "before_count": len(before), "after_count": len(after)}
path = root/'scratch'/'source-cli-smoke988-output.json'
path.write_text(json.dumps(out, indent=2))
print(json.dumps(out, indent=2))
if code is None: sys.exit(124)
sys.exit(code)
