#!/usr/bin/env bash
# Before-and-after frames of the Agents → Roster page, one subagent's page, one
# helper's page, and the roster after leaving that helper's page.
#
#   proof/record.sh --pair proof/scenes/settings-roster.sh
#
# The roster is opened through settings search, so both arms reach it the same
# way. Guards wait on text both arms print. The two arms order the list
# differently, so the Down counts come from arm_key and each state keeps one shot
# name: before, ten helper rows lead and the first subagent is the eleventh row;
# after, the first subagent is the first row and the six bundled subagents sit
# above the first helper.
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
key_repeat Down "$(arm_key 6 0)" 0.1
settle 1
k Return
expect_screen "Effort" 20 helper-page
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
