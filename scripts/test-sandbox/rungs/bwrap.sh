#!/usr/bin/env bash
# The bwrap rung: bubblewrap with a mount and user namespace.
#
# Usage: sourced by scripts/test-sandbox/run.sh; not run directly. It defines
# probe_bwrap, run_bwrap and binprobe_bwrap and reads REPO_ROOT, GUEST_REPO and
# HOST_HOME from the driver.
#
# It is last on the ladder. Some hosts deny the uid_map write through AppArmor
# despite enabling unprivileged user namespaces, so the probe runs bwrap rather
# than merely checking PATH.

# Resolve host executables while the host PATH is still intact. Only a real ELF file
# is bound into the sandbox: a shell wrapper would reach it as a broken command, and
# a directory bind would expose the host tree. The PATH proof narrows PATH after
# sourcing this rung, so the resolution must happen here.
resolve_host_elf() {
	local resolved magic
	resolved="$(readlink -f -- "$1" 2>/dev/null || true)"
	if [ -z "$resolved" ] || [ ! -x "$resolved" ]; then return 0; fi
	magic="$(od -An -tx1 -N4 -- "$resolved" 2>/dev/null || true)"
	if [ "${magic//[[:space:]]/}" = 7f454c46 ]; then printf '%s\n' "$resolved"; fi
	return 0
}
BWRAP_HOST_BUN_PATH="$(resolve_host_elf "$(bun -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)")"
BWRAP_HOST_NODE_PATH="$(resolve_host_elf "$(command -v node 2>/dev/null || true)")"
BWRAP_HOST_GH_PATH="$(resolve_host_elf "${VEYYON_BWRAP_GH:-}")"

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
	local -a runtime_mounts=()
	if [ -n "${BWRAP_HOST_BUN_PATH:-}" ] && [ -x "$BWRAP_HOST_BUN_PATH" ]; then
		log "Bun executable resolved to ${BWRAP_HOST_BUN_PATH}"
		runtime_mounts=(--ro-bind "$BWRAP_HOST_BUN_PATH" /sandbox/runtime/bun/bun)
	else
		log "Bun runtime resolution failed: expected an executable ELF binary from process.execPath"
		return "${RUNG_SETUP_FAILED:-126}"
	fi
	if [ -n "${BWRAP_HOST_NODE_PATH:-}" ] && [ -x "$BWRAP_HOST_NODE_PATH" ]; then
		log "Node executable resolved to ${BWRAP_HOST_NODE_PATH}"
		runtime_mounts+=(--ro-bind "$BWRAP_HOST_NODE_PATH" /sandbox/runtime/bun/node)
	else
		log "Node runtime resolution failed: expected an ELF binary from command -v node"
		return "${RUNG_SETUP_FAILED:-126}"
	fi
	if [ -n "${BWRAP_HOST_GH_PATH:-}" ] && [ -x "$BWRAP_HOST_GH_PATH" ]; then
		log "gh executable resolved to ${BWRAP_HOST_GH_PATH}"
		runtime_mounts+=(--ro-bind "$BWRAP_HOST_GH_PATH" /sandbox/runtime/bun/gh)
	else
		log "gh runtime resolution failed: VEYYON_BWRAP_GH must name an ELF binary"
		return "${RUNG_SETUP_FAILED:-126}"
	fi

	[ -n "${SANDBOX_GITDIR:-}" ] && gitdir_args=(--ro-bind "${SANDBOX_GITDIR}" "${SANDBOX_GITDIR}")

	local -a extra_mounts=()
	if [ -n "${VEYYON_SANDBOX_NODE_MODULES:-}" ]; then
		if [ ! -d "${VEYYON_SANDBOX_NODE_MODULES}" ]; then
			log "Linux node_modules directory does not exist: ${VEYYON_SANDBOX_NODE_MODULES}"
			return "${RUNG_SETUP_FAILED:-126}"
		fi
		extra_mounts+=(--ro-bind "${VEYYON_SANDBOX_NODE_MODULES}" "${GUEST_REPO}/node_modules")
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
	local -a cgroup_mounts=()
	if [ -d "/sys/fs/cgroup" ]; then
		cgroup_mounts=(--dir /sys --dir /sys/fs --ro-bind-try /sys/fs/cgroup /sys/fs/cgroup)
	fi

	bwrap \
		--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
		--die-with-parent --new-session \
		--ro-bind /usr /usr --ro-bind /etc /etc \
		--symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --symlink usr/sbin /sbin \
		--proc /proc --dev /dev \
		--tmpfs /sandbox --tmpfs /run \
		"${cgroup_mounts[@]}" \
		"${runtime_mounts[@]}" \
		--tmpfs /home --tmpfs /tmp \
		--bind "${REPO_ROOT}" "${GUEST_REPO}" \
		"${gitdir_args[@]+"${gitdir_args[@]}"}" \
		"${extra_mounts[@]}" \
		--chdir "${GUEST_REPO}" \
		--setenv PATH /sandbox/runtime/bun:/usr/local/bin:/usr/bin:/bin:/usr/local/sbin:/usr/sbin:/sbin \
		--setenv VEYYON_TEST_SANDBOX bwrap-userns \
		--setenv VEYYON_TEST_HOST_HOME "${HOST_HOME}" \
		--setenv HOME /sandbox/home \
		--setenv TMPDIR /tmp \
		--setenv BUN_INSTALL_CACHE_DIR /sandbox/home/.bun/install/cache \
		/bin/sh -c 'mkdir -p "$HOME"; exec "$@"' _ "$@"
}

# Used by --probe to list which binaries the rung provides.
binprobe_bwrap() { run_bwrap /bin/sh -c "$1"; }
