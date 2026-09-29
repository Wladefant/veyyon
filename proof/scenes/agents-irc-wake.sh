#!/usr/bin/env bash
# A spawned agent that an IRC message woke, and the Agents block that should list it.
#
# The claim (https://github.com/Wladefant/veyyon/issues/87): an agent whose first run
# is over sits idle, a message over IRC wakes a new turn in it, and while that turn
# runs the Agents block above the composer lists it. Before the fix the status line
# counted the agent as running and the block had no row for it, because the block
# followed only the executor's own lifecycle events and a wake reports to the agent
# registry alone.
#
# The order matters and a model does not keep it on cue, so the take records against
# proof/docker/irc-wake-model.ts: it spawns Scout, waits on the job until Scout's first
# run has ended, messages Scout, and streams Scout's woken turn slowly enough to
# photograph. The CLI, the task and irc tools, the registries and the block are the
# shipped product.
#
#   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
#     --mount type=bind,src="$PWD/proof/docker",dst=/srv,readonly \
#     veyyon-proof-recorder:bun1.4.0-r3 bun /srv/irc-wake-model.ts
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/demo-qwen38-27b-96k' \
#     proof/record.sh --pair proof/scenes/agents-irc-wake.sh
#
# The 96k row is the same `local` provider under a window larger than the system prompt,
# so the footer does not open at "0% left".

# The Agents block's header row: the rail, then the word alone on its line. The word
# also appears in tool output, but never as a whole line after the rail.
agents_block_shown() {
	visible_text | grep -Eq '^[^[:alnum:]]*Agents[[:space:]]*$'
}

settle 12

submit "Spawn a Scout to review src/rate-limiter.ts, wait for it to finish, then send it a follow-up over IRC."
# needle-source: Sent Scout a follow-up -- the closing sentence proof/docker/irc-wake-model.ts streams after the irc send
expect_model_screen "Sent Scout a follow-up" 120
# Scout's woken turn streams for a minute; the frame is taken inside it.
sleep 4

if [ "${SCENE_ARM:-after}" = "after" ]; then
	for _ in $(seq 1 20); do
		agents_block_shown && break
		sleep 0.5
	done
	agents_block_shown || abandon_take agents-block "the Agents block never listed the woken agent"
else
	agents_block_shown && abandon_take agents-block "the before arm already lists the woken agent"
fi
shot woken-agent
