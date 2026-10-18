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
# Node's process.execPath bypasses command lookup. mdbook and rg use command -v;
# resolve asdf shims with `asdf which`, then canonicalize with readlink -f and validate ELF.
resolve_host_tool() {
	local name="$1" command_path asdf_shims
	command_path="$(command -v "$name" 2>/dev/null || true)"
	asdf_shims="${ASDF_DATA_DIR:-${HOME:-}/.asdf}/shims/"
	if [[ -n "$command_path" && ( "$command_path" == "$asdf_shims"* || "$command_path" == */.asdf/shims/* ) ]]; then
		if command -v asdf >/dev/null 2>&1; then
			command_path="$(asdf which "$name" 2>/dev/null || true)"
		else
			command_path=""
		fi
	fi
	resolve_host_elf "$command_path"
}
BWRAP_HOST_BUN_PATH="$(resolve_host_elf "$(bun -e 'process.stdout.write(process.execPath)' 2>/dev/null || true)")"
BWRAP_HOST_NODE_PATH="$(resolve_host_elf "$(node -p process.execPath 2>/dev/null || true)")"
BWRAP_HOST_GH_PATH="$(resolve_host_elf "${VEYYON_BWRAP_GH:-$(command -v gh 2>/dev/null || true)}")"
BWRAP_HOST_MDBOOK_PATH="$(resolve_host_tool mdbook)"
BWRAP_HOST_RG_PATH="$(resolve_host_tool rg)"

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
		log "Node runtime resolution failed: expected an ELF binary from node process.execPath"
		return "${RUNG_SETUP_FAILED:-126}"
	fi
	if [ -n "${BWRAP_HOST_GH_PATH:-}" ] && [ -x "$BWRAP_HOST_GH_PATH" ]; then
		log "gh executable resolved to ${BWRAP_HOST_GH_PATH}"
		runtime_mounts+=(--ro-bind "$BWRAP_HOST_GH_PATH" /sandbox/runtime/bun/gh)
	else
		log "gh runtime resolution failed: gh must name an ELF binary"
		return "${RUNG_SETUP_FAILED:-126}"
	fi

	if [ -n "${BWRAP_HOST_MDBOOK_PATH:-}" ] && [ -x "$BWRAP_HOST_MDBOOK_PATH" ]; then
		log "mdbook executable resolved to ${BWRAP_HOST_MDBOOK_PATH}"
		runtime_mounts+=(--ro-bind "$BWRAP_HOST_MDBOOK_PATH" /sandbox/runtime/bun/mdbook)
	else
		log "mdbook runtime resolution failed: expected an executable ELF binary from PATH or asdf which"
		return "${RUNG_SETUP_FAILED:-126}"
	fi
	if [ -n "${BWRAP_HOST_RG_PATH:-}" ] && [ -x "$BWRAP_HOST_RG_PATH" ]; then
		log "rg executable resolved to ${BWRAP_HOST_RG_PATH}"
		runtime_mounts+=(--ro-bind "$BWRAP_HOST_RG_PATH" /sandbox/runtime/bun/rg)
	else
		log "rg runtime resolution failed: expected an executable ELF binary from PATH or asdf which"
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
	# Non-root identity. Pass --uid/--gid explicitly: bwrap.xml documents them as requiring
	# --unshare-user. A nonzero host uid and gid map to themselves, so the bound repository keeps
	# its host owner and nothing is chowned. A root host identity falls back to 65534.
	# --chmod is applied as the last filesystem operation, after every mount that creates a
	# directory under /, so the root path is 0555 and refuses writes to the sandbox user (EACCES).
	local host_uid host_gid sandbox_uid sandbox_gid
	host_uid="$(id -u)"
	host_gid="$(id -g)"
	sandbox_uid="$host_uid"
	sandbox_gid="$host_gid"
	if [ "$sandbox_uid" = 0 ]; then sandbox_uid=65534; fi
	if [ "$sandbox_gid" = 0 ]; then sandbox_gid=65534; fi
	log "Sandbox identity uid=${sandbox_uid} gid=${sandbox_gid} (host ${host_uid}:${host_gid})"

	bwrap \
		--unshare-user --unshare-pid --unshare-ipc --unshare-uts --unshare-cgroup \
		--uid "$sandbox_uid" --gid "$sandbox_gid" \
		--die-with-parent --new-session \
		--ro-bind /usr /usr --ro-bind /etc /etc \
		--symlink usr/lib /lib --symlink usr/lib64 /lib64 --symlink usr/bin /bin --symlink usr/sbin /sbin \
		--proc /proc --dev /dev \
		--tmpfs /sandbox --tmpfs /run \
		"${cgroup_mounts[@]}" \
		"${runtime_mounts[@]}" \
		--tmpfs /home --perms 1777 --tmpfs /tmp \
		--bind "${REPO_ROOT}" "${GUEST_REPO}" \
		"${gitdir_args[@]+"${gitdir_args[@]}"}" \
		"${extra_mounts[@]}" \
		--chmod 0555 / \
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
