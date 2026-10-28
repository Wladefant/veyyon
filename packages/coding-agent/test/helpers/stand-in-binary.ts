/**
 * A stand-in release binary that answers the three things `verifyBinaryUsable` asks of a freshly
 * installed one: `--version` in the `veyyon/X.Y.Z` shape it parses, `grep --help`, and a `grep`
 * that finds the file it is pointed at. A stub that faked the search would satisfy the probe even
 * if the update had stopped pointing it anywhere, which is the failure the probe exists to catch.
 */
export function standInBinary(version: string): string {
	return `#!/bin/sh
set -u
case "\${1:-}" in
	--version) echo "veyyon/${version}"; exit 0 ;;
	grep)
		[ "\${2:-}" = "--help" ] && { echo "usage: veyyon grep <pattern> <path>"; exit 0; }
		exec grep -rl -- "$2" "$3" ;;
	*) echo "unknown command: \${1:-}" >&2; exit 2 ;;
esac
`;
}
