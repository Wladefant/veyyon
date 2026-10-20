#!/usr/bin/env bash
# Before-and-after pair for an overlay card on a terminal shorter than the card's old height floor.
#
# The model picker floored its height at 16 rows and the host mounts it top-anchored with
# `maxHeight: "100%"`, so on a shorter terminal the overlay cut the rows past the screen: the
# footer chips (`enter use`, `esc close`) and the bottom border. Before: the card runs off the
# bottom edge. After: the card fits the screen with its footer.
#
#   SCENE_HEIGHT=300 proof/record.sh --pair proof/scenes/model-picker-short-terminal.sh
settle 18
submit "/model"
expect_screen "Switch Model" 60 picker-open
settle 2
shot picker-short-terminal
k Escape
settle 2
