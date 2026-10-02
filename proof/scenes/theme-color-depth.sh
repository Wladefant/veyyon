#!/usr/bin/env bash
# Theme colour depth under a terminal that does not advertise truecolor.
#
# Record with the environment macOS Terminal.app hands its child: TERM_PROGRAM
# set, TERM=xterm-256color, no COLORTERM, and none of kitty's own markers:
#
#   SCENE_COMMAND="env -u COLORTERM -u KITTY_WINDOW_ID -u KITTY_PID \
#     TERM_PROGRAM=Apple_Terminal TERM=xterm-256color \
#     bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b"
#
# The before arm sends 24-bit SGR to that terminal; the after arm sends the
# 256-colour palette. /out/theme-color-depth-sgr.txt counts each form in what
# the app wrote, so the frames are backed by the bytes.
set +e
settle 10
shot startup
t "/"
pause 2
shot commands
k Escape
pause 1
{
	echo "-- env: TERM=${TERM} TERM_PROGRAM=${TERM_PROGRAM:-} COLORTERM=${COLORTERM:-}"
	for f in /tmp/term.log /tmp/app-out.raw "${TMPDIR:-/tmp}"/app-out.raw; do
		[ -f "$f" ] || continue
		echo "-- ${f}: 24-bit fg/bg $(grep -aoE $'\e\\[[0-9;]*[34]8;2;' "$f" | wc -l), 256-colour fg/bg $(grep -aoE $'\e\\[[0-9;]*[34]8;5;' "$f" | wc -l)"
	done
} >/out/theme-color-depth-sgr.txt 2>&1
