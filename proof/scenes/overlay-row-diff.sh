#!/usr/bin/env bash
# What a keystroke in a fullscreen overlay writes to the terminal.
#
# WHAT IT SHOWS. Settings is a fullscreen overlay on the alternate screen. Every
# keystroke there used to rewrite all of its rows; it now rewrites only the rows
# that changed while the overlay's size holds. The frames are the same in both
# arms by design. The difference is the byte count, so the scene states it.
#
# HOW TO RECORD. Run both arms with the terminal write log on, at the path this
# scene reads:
#
#   SCENE_COMMAND="env VEYYON_TUI_WRITE_LOG=/out/overlay-row-diff-tui.log bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b" \
#   PROOF_BASE_REF=<merge>^1 proof/record.sh --pair proof/scenes/overlay-row-diff.sh
#
# Each arm's log line `scene: overlay keystrokes wrote N bytes` is the evidence.

TUI_LOG="${SCENE_OUT}/${SCENE_NAME}-tui.log"
log_bytes() { # log_bytes: bytes the app has written so far, 0 without the write log
	if [ -f "${TUI_LOG}" ]; then wc -c <"${TUI_LOG}"; else echo 0; fi
}

settle 16
submit "/settings"
settle 3
# needle-source: Appearance -- the settings sidebar, so the overlay holds the alternate screen
expect_screen "Appearance" 30
shot settings

START_BYTES="$(log_bytes)"
for _ in 1 2 3 4 5 6; do
	k Down
	settle 1
done
END_BYTES="$(log_bytes)"
echo "scene: overlay keystrokes wrote $((END_BYTES - START_BYTES)) bytes for 6 Down presses" >&2
shot moved
k Escape
settle 2
