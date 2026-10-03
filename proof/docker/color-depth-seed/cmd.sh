#!/usr/bin/env bash
# Starts the CLI with the environment macOS Terminal.app hands its child:
# TERM_PROGRAM set, TERM=xterm-256color, no COLORTERM and none of kitty's own
# markers. `script` keeps a copy of every byte the app writes, so the scene can
# count the 24-bit and 256-colour SGR forms the frames were drawn with.
exec env -u COLORTERM -u KITTY_WINDOW_ID -u KITTY_PID -u KITTY_INSTALLATION_DIR \
	TERM_PROGRAM=Apple_Terminal TERM=xterm-256color \
	script -qfec "bun /repo/packages/coding-agent/src/cli.ts --model local/qwen2.5-1.5b" /out/theme-color-depth-app.raw
