#!/usr/bin/env bash
# A Mermaid state diagram in a reply, drawn in the terminal.
#
# WHAT IT SHOWS. One reply carries a `stateDiagram-v2` fence with a start and an
# end pseudostate and three labelled transitions that crowd one connector. Three
# things decide whether the drawing reads:
#
#   1. Strokes. Box borders, junctions and connector lines are drawn in the
#      theme's `muted` foreground rather than its UI-chrome border colour, which
#      on Titanium sits a few steps above the background.
#   2. Pseudostates. `[*]` draws as the UML start dot `●` and end target `◎`
#      instead of an empty box.
#   3. Labels. Each transition label stays whole above the connector stroke it
#      shares, rather than being cut by the line drawn after it.
#
# WHY A SEEDED SESSION. No model can be asked for an exact diagram, and both arms
# of the pair must draw the same source. The reply is a committed fixture
# (proof/docker/seed-mermaid/), copied into the session store by seed-demo.sh for
# this scene only, and reached the way a user reaches yesterday's answer: by
# `/resume` with the session's file stem.
#
# HOW TO RECORD THE PAIR. A static change, so the artifact is a pair of stills.
# The diagram is 31 rows tall, so the window is taller than the default to hold
# the user turn, the whole drawing and the line after it in one frame:
#
#   SCENE_HEIGHT=1320 SCENE_MOTION_FLOOR=0 \
#     proof/record.sh --pair proof/scenes/mermaid-state-diagram.sh

STEM="2026-08-14T11-00-00-000Z_0198ab02-9d53-7000-9d0e-4a1f2b6c8e22"

settle 16
submit "/resume ${STEM}"
settle 6

# needle-source: Draw the session lifecycle as a state diagram. -- the seeded user turn
expect_screen "Draw the session lifecycle as a state diagram." 30
# needle-source: A session starts in Working and ends from Archived. -- the line after the fence
expect_screen "A session starts in Working and ends from Archived." 30
# needle-source: Archived -- a state box the renderer drew, so the fence was rendered rather than shown as source
expect_screen "Archived" 30

if [ "${SCENE_ARM:-after}" = "after" ]; then
	# needle-source: ◎ -- the end pseudostate marker the after arm draws; the before arm draws an empty box
	expect_screen "◎" 30
	# needle-source: sessions die and respawn freely -- the label the after arm keeps whole; the before arm runs the stroke through its spaces
	expect_screen "sessions die and respawn freely" 30
fi

shot diagram
