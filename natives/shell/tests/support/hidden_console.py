import os
import subprocess
import sys

os.environ["VEYYON_READ_REQUIRE_CONSOLE"] = "1"
startup = subprocess.STARTUPINFO()
startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
startup.wShowWindow = subprocess.SW_HIDE
result = subprocess.run(
    sys.argv[1:],
    creationflags=subprocess.CREATE_NEW_CONSOLE,
    startupinfo=startup,
    capture_output=True,
    text=True,
)
sys.stdout.write(result.stdout)
sys.stderr.write(result.stderr)
raise SystemExit(result.returncode)
