#!/usr/bin/env bash
# Before-and-after frames of the Agents → Roster page, one subagent's page, the
# Commit helper's page, and the roster after leaving that helper's page.
#
#   proof/record.sh --pair proof/scenes/settings-roster.sh
#
# The roster is opened through settings search, so both arms reach it the same
# way. Guards wait on text both arms print. The two arms order the list
# differently, so the Down counts come from arm_key and each state keeps one shot
# name: before, ten helper rows lead and the first subagent is the eleventh row;
# after, the first subagent is the first row and the six bundled subagents sit
# above the first helper. Commit is the fourth helper, not the first, so the
# roster-return frame tells a return to the opening row from a return to the top.
# needle-source: Helper: Commit -- the helper page title, `Helper: ` and the Commit helper's label from HELPERS
settle 18
submit "/settings"
expect_screen "Settings" 60 settings-open
settle 2

t "roster"
settle 2
expect_screen "Roster" 30 roster-search
k Return
expect_screen "HELPERS" 30 roster-page
settle 2
shot roster-page

key_repeat Down "$(arm_key 0 10)" 0.1
settle 1
k Return
expect_screen "Effort" 20 agent-page
settle 2
shot agent-page

k Escape
settle 1
key_repeat Down "$(arm_key 9 3)" 0.1
settle 1
k Return
expect_screen "Helper: Commit" 20 helper-page
settle 2
shot helper-page

k Escape
settle 2
shot roster-return

k Escape
settle 1
k Escape
settle 1
k Escape
settle 2
