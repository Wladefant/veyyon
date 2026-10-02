#!/usr/bin/env bash
# The /btw panel's branch action while the main turn is busy, after it moved on, and in flight.
#
# The claim (Refs https://github.com/Wladefant/veyyon/issues/107, PR
# https://github.com/Wladefant/veyyon/pull/356): the panel offers "b branch to chat" only
# when the controller would accept it. While the main turn is still streaming the hint is
# gone; once the turn has moved the session past the point /btw saw, `b` says why it is
# refused instead of typing a stray "b"; and an accepted branch shows "Branching to chat…"
# until the new session exists. Before the fix the hint was printed whenever the answer
# could be copied, a stale `b` fell through into the composer, and the footer said nothing
# while the branch ran.
#
# The timing is the subject, so the take records against proof/docker/btw-branch-model.ts,
# which streams the main reply for thirty seconds and answers /btw at once, and loads
# proof/docker/btw-branch-hold.ts, an extension that holds the session_before_branch hook
# for ten seconds so the in-flight state is on the glass long enough to photograph. The
# CLI, /btw, the panel, the session and its branch are the shipped product. Most of the
# take is a screen waiting on that timing, so it measures about 4 fps of real change and
# records with the motion floor lowered rather than the waits cut.
#
#   docker run -d --rm --name veyyon-proof-llm --network veyyon-proof \
#     --mount type=bind,src="$PWD/proof/docker",dst=/srv,readonly \
#     veyyon-proof-recorder:bun1.4.0-r3 bun /srv/btw-branch-model.ts
#   SCENE_COMMAND='bun /repo/packages/coding-agent/src/cli.ts --model local/demo-qwen38-27b-96k --extension /repo/proof/docker/btw-branch-hold.ts' \
#     SCENE_MOTION_FLOOR=1 proof/record.sh --pair proof/scenes/btw-branch-guards.sh

# Ask /btw without the Escape `slash` sends. That Escape is there to dismiss the
# completion popup, but a command typed with its argument has no popup open, so the
# key reaches the editor and interrupts the main turn -- ending the very turn the
# first frame has to show still streaming.
btw() {
	clear_composer
	t "$1"
	pause 0.7
	k Return
}

settle 12

submit "Walk me through the rate limiter's refill window."
# needle-source: Walking through the refill window -- the main reply proof/docker/btw-branch-model.ts streams
expect_model_screen "Walking through the refill window" 60

# State 1: a side answer that completes while the main turn is still streaming.
btw "/btw how full is the bucket at the start?"
# needle-source: The bucket starts full -- the /btw answer proof/docker/btw-branch-model.ts returns
expect_model_screen "The bucket starts full" 30
expect_screen "Esc dismiss" 10
pause 1
case "$(row_with "Esc dismiss")" in
*"b branch to chat"*)
	[ "${SCENE_ARM:-after}" = "after" ] && abandon_take busy-footer "the after arm offers branch while the main turn streams"
	;;
*)
	[ "${SCENE_ARM:-after}" = "after" ] || abandon_take busy-footer "the before arm already hides branch while the main turn streams"
	;;
esac
shot busy-footer

# State 2: the main turn ended, so the session moved past the point /btw saw.
# needle-source: That is the whole refill path. -- the closing sentence proof/docker/btw-branch-model.ts streams
expect_model_screen "That is the whole refill path." 90
settle 2
k b
pause 1
if [ "${SCENE_ARM:-after}" = "after" ]; then
	# needle-source: /btw branch unavailable: the session changed since /btw started -- btw-controller.ts showStatus with the stale-session reason
	expect_screen "/btw branch unavailable: the session changed since /btw started" 10
fi
shot stale-branch-key

k Escape
pause 0.5
clear_composer

# State 3: a fresh side answer on the idle session, branched into chat.
btw "/btw what empties the bucket?"
# needle-source: Requests empty it -- the second /btw answer proof/docker/btw-branch-model.ts returns
expect_model_screen "Requests empty it" 30
pause 1
case "$(row_with "Esc dismiss")" in
*"b branch to chat"*) ;;
*) abandon_take idle-footer "the idle panel does not offer branch" ;;
esac
k b
pause 2
if [ "${SCENE_ARM:-after}" = "after" ]; then
	expect_screen "Branching to chat" 5
elif screen_has "Branching to chat"; then
	abandon_take branching "the before arm already shows the in-flight branch"
fi
shot branching

expect_screen "Branched /btw" 30
