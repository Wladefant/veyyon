#!/usr/bin/env bash
# A skill found from a later word of its name.
#
# WHAT IT SHOWS. Skill names are hyphenated (`release-notes`), and a user who
# remembers the second word types `/notes`. A slash token typed in the middle of
# a prompt matched a skill only from the first letter of its bare name, so it
# found nothing and the popup never opened. It now matches from the start of any
# hyphen-delimited word.
#
# The `leading` frame is the control: at the start of the composer the command
# list found the skill before the change too, so both arms draw the same popup.
# The `mid-prompt` frame is the change.
#
# The skill is seeded by proof/docker/seed-demo.sh for this scene only, so no
# other scene's command list changes.
#
# HOW TO RECORD THE PAIR. A static change, so two stills per state:
#
#   PROOF_BASE_REF=<merge>^1 proof/record.sh --pair proof/scenes/skill-hyphen-prefix.sh

settle 16

t "/notes"
settle 2
# needle-source: skill:release-notes -- the seeded skill's command, found at the start of the composer in both arms
expect_screen "skill:release-notes" 20
shot leading
clear_composer
settle 1

t "write up this week with /notes"
settle 2
if [[ "${SCENE_ARM:-after}" != "before" ]]; then
	# needle-source: skill:release-notes -- the mid-prompt skill popup
	expect_screen "skill:release-notes" 20
fi
shot mid-prompt
clear_composer
