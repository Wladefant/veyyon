#!/usr/bin/env bash
# A click on an agent's row in the Agents block, while veyyon holds the mouse.
#
# The claim (oh-my-pi 42cab80d, mouse-only form aef2ec9a; Wladefant/veyyon#107): with
# scroll isolation on, a left click on a running agent's row focuses that agent, the
# same as picking it in /agents. Before, the engine swallowed every click above the
# pinned footer, so the row was text a click could not reach.
#
# Two agents run, so the frame also shows the click picked the row under the pointer
# and not its neighbour: the after arm must name Scout, the agent the click was on.
#
# The take records against proof/docker/hud-click-model.ts, which spawns Scout and
# Linter and keeps both streaming for three minutes. Both arms seed scroll isolation,
# because the engine holds the mouse only then:
#
#   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
#     --mount type=bind,src="$PWD/proof/docker",dst=/srv,readonly \
#     veyyon-proof-recorder:bun1.4.0-r3 bun /srv/hud-click-model.ts
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/demo-qwen38-27b-96k' \
#     proof/record.sh --pair --settings 'tui.scrollIsolation: true' proof/scenes/agent-hud-click.sh

# Scout's row in the Agents block: its id, then the colon before the spawn's label.
# The transcript can carry the name too; row_of takes the bottom-most match, which is
# the block above the composer.
agent_row_shown() {
	visible_text | grep -Fq 'Scout:'
}

settle 12

submit "Spawn a Scout to review src/rate-limiter.ts and a Linter to audit biome.json, both in the background."
# needle-source: Scout and Linter are running -- the closing sentence proof/docker/hud-click-model.ts streams after the task result
expect_model_screen "Scout and Linter are running" 120

for _ in $(seq 1 20); do
	agent_row_shown && break
	sleep 0.5
done
agent_row_shown || abandon_take agents-block "the Agents block never listed Scout"
shot listed

click_text_in_row "Scout:" "Scout"
sleep 3

if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "Viewing agent Scout" 20
else
	visible_text | grep -Fq "Viewing agent" && abandon_take focus "the before arm focused an agent on click"
fi
shot clicked
