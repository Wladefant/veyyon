import stat
import sys
from pathlib import Path

archive = Path(sys.argv[1]).read_bytes()
entries = {}
offset = 0
while offset < len(archive):
    header = archive[offset:offset + 110]
    if len(header) != 110 or header[:6] not in (b"070701", b"070702"):
        raise RuntimeError("Invalid newc archive header")
    fields = [int(header[6 + index * 8:14 + index * 8], 16) for index in range(13)]
    name_end = offset + 110 + fields[11]
    name = archive[offset + 110:name_end - 1].decode("utf8")
    body = (name_end + 3) & ~3
    offset = (body + fields[6] + 3) & ~3
    if name == "TRAILER!!!":
        break
    entries[name.removeprefix("./")] = fields

for name, permissions, major, minor in (
    ("dev/console", 0o600, 5, 1),
    ("dev/null", 0o666, 1, 3),
):
    actual = entries.get(name)
    if actual is None:
        raise AssertionError(f"Missing {name}")
    if not stat.S_ISCHR(actual[1]) or stat.S_IMODE(actual[1]) != permissions:
        raise AssertionError(f"Wrong character mode for {name}: {actual[1]:o}")
    if (actual[9], actual[10]) != (major, minor):
        raise AssertionError(f"Wrong device address for {name}: {actual[9]}:{actual[10]}")
    print(f"CLOUDFLARE_DEVICE_NODE_PASS {name} mode={actual[1]:o} rdev={major}:{minor}")
print("CLOUDFLARE_DEVICE_NODE_SUMMARY pass=2 fail=0")
