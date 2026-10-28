#!/usr/bin/env bash
# The bwrap rung: bubblewrap with a mount and user namespace.
#
# Usage: sourced by scripts/test-sandbox/run.sh; not run directly. It defines
# probe_bwrap, run_bwrap and binprobe_bwrap and reads REPO_ROOT and HOST_HOME from
# the driver.
#
# It is last on the ladder. Some hosts deny the uid_map write through AppArmor
# despite enabling unprivileged user namespaces, so the probe runs bwrap rather
# than merely checking PATH.

probe_bwrap() {
	command -v bwrap >/dev/null 2>&1 || { skip bwrap "bubblewrap not on PATH"; return 1; }
	# Run it. The sysctls claim unprivileged userns is enabled on hosts where
	# AppArmor then refuses the uid_map write, so only an execution is evidence.
	local err
	if ! err="$(bwrap --unshare-user --ro-bind / / --tmpfs /home /bin/true 2>&1)"; then
		skip bwrap "bubblewrap cannot create a user namespace here: ${err%%$'\n'*}"
		return 1
	fi
	return 0
}

run_bwrap() {
	# A linked worktree's `.git` names an absolute path outside the repo bind, so it is
	# bound read-only at that same path or every `git` call inside sees a tree that is
	# not a repository. The driver leaves SANDBOX_GITDIR empty for a checkout that owns
	# its own `.git`, and for one whose git directory is inside the home being hidden.
	local -a gitdir_args=()
	[ -n "${SANDBOX_GITDIR:-}" ] && gitdir_args=(--ro-bind "${SANDBOX_GITDIR}" "${SANDBOX_GITDIR}")

	local -a extra_mounts=()
	if [ -n "${VEYYON_SANDBOX_NODE_MODULES:-}" ]; then
		if [ ! -d "${VEYYON_SANDBOX_NODE_MODULES}" ]; then
			log "Linux node_modules directory does not exist: ${VEYYON_SANDBOX_NODE_MODULES}"
			return "${RUNG_SETUP_FAILED:-126}"
		fi
		extra_mounts+=(--ro-bind "${VEYYON_SANDBOX_NODE_MODULES}" "${REPO_ROOT}/node_modules")
	elif [ -L "${REPO_ROOT}/node_modules" ]; then
		local nm_target
		nm_target="$(readlink "${REPO_ROOT}/node_modules" 2>/dev/null || true)"
		if [ -n "$nm_target" ] && [ -d "$nm_target" ]; then
			local nm_parent
			nm_parent="$(dirname "$nm_target")"
			extra_mounts+=(--ro-bind "$nm_parent" "$nm_parent")
			if [ -d "${REPO_ROOT}/packages" ] && [ -d "${nm_parent}/packages" ]; then
				extra_mounts+=(--bind "${REPO_ROOT}/packages" "${nm_parent}/packages")
			fi
		fi
	fi

	# bwrap passes the host environment through, so the terminal identity the engine reads to detect
	# a multiplexer is removed here, for the reason given in rungs/docker.sh.
	local -a term_args=() name
	for name in TERM TERM_PROGRAM TERM_PROGRAM_VERSION TMUX STY ZELLIJ CMUX_WORKSPACE_ID CMUX_SURFACE_ID; do
		term_args+=(--unsetenv "$name")
	done
	bwrap \
		--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
		--die-with-parent --new-session \
		--ro-bind /usr /usr --ro-bind /etc /etc \
		--symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --symlink usr/sbin /sbin \
		--proc /proc --dev /dev \
		--tmpfs /home --tmpfs /tmp --tmpfs /sandbox --tmpfs /run \
		--bind "${REPO_ROOT}" "${REPO_ROOT}" \
		"${gitdir_args[@]+"${gitdir_args[@]}"}" \
		"${extra_mounts[@]}" \
		--chdir "${REPO_ROOT}" \
		--setenv PATH /usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin \
		--setenv VEYYON_TEST_SANDBOX bwrap-userns \
		--setenv VEYYON_TEST_HOST_HOME "${HOST_HOME}" \
		--setenv HOME /sandbox/home \
		--setenv TMPDIR /tmp \
		--setenv BUN_INSTALL_CACHE_DIR /sandbox/home/.bun/install/cache \
		"${term_args[@]}" \
		/bin/sh -c 'mkdir -p "$HOME"; exec "$@"' _ "$@"
}

# Used by --probe to list which binaries the rung provides.
binprobe_bwrap() { run_bwrap /bin/sh -c "$1"; }
