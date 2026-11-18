use std::{
	collections::HashSet,
	env,
	ffi::OsString,
	os::windows::process::CommandExt,
	path::{Path, PathBuf},
	process::{Command, Stdio},
	sync::{
		Arc, Condvar, LazyLock, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use anyhow::{Error, Result};
use brush_core::{Shell as BrushShell, ShellValue, ShellVariable};
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use winreg::{RegKey, enums::HKEY_LOCAL_MACHINE};

const WHERE_GIT_TIMEOUT: Duration = Duration::from_secs(2);
const WHERE_POLL_INTERVAL: Duration = Duration::from_millis(20);
const MAX_WHERE_STDOUT_BYTES: usize = 16 * 1024;
const GIT_ENV_CACHE_TTL: Duration = Duration::from_secs(30);
const MAX_WIN_INIT_WORKERS: usize = 64;
const WIN_INIT_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Clone, Default)]
struct GitEnvironment {
	install_roots: Vec<PathBuf>,
	git_paths:     Vec<String>,
}

#[derive(Default)]
struct GitEnvCacheState {
	cached:    Option<(Option<OsString>, Instant, GitEnvironment)>,
	in_flight: bool,
}

static GIT_ENV_CACHE: LazyLock<(Mutex<GitEnvCacheState>, Condvar)> =
	LazyLock::new(|| (Mutex::new(GitEnvCacheState::default()), Condvar::new()));
static WIN_INIT_SEMAPHORE: LazyLock<Arc<tokio::sync::Semaphore>> =
	LazyLock::new(|| Arc::new(tokio::sync::Semaphore::new(MAX_WIN_INIT_WORKERS)));
pub fn configure_windows_path(shell: &mut BrushShell) -> Result<()> {
	let hook_key = test_hook_key(shell);
	let existing_path = existing_shell_path(shell);
	if let Some(updated_path) =
		resolve_windows_path(&existing_path, None, hook_key.as_deref())?
	{
		apply_updated_path(shell, updated_path)?;
	}
	Ok(())
}
/// Computes and applies Windows `TEMP`/`TMP`/`TMPDIR` long-path expansion and
/// `PATH` adjustments off Tokio worker and blocking-pool threads, aborting
/// promptly when `cancel_token` fires.
pub(crate) async fn configure_windows_session_cancellable(
	shell: &mut BrushShell,
	cancel_token: Option<&CancellationToken>,
) -> Result<()> {
	let hook_key = test_hook_key(shell);
	let existing_path = existing_shell_path(shell);
	let temp_vars: Vec<(&'static str, String)> = ["TEMP", "TMP", "TMPDIR"]
		.into_iter()
		.filter_map(|key| {
			let value = shell.env().get(key).and_then(|(_, var)| match var.value() {
				ShellValue::String(value) if Path::new(value).is_absolute() => Some(value.clone()),
				_ => None,
			})?;
			Some((key, value))
		})
		.collect();
	let permit = if let Some(token) = cancel_token {
		tokio::select! {
			biased;
			() = token.cancelled() => return Err(Error::msg("Windows session initialization cancelled")),
			res = tokio::time::timeout(WIN_INIT_ACQUIRE_TIMEOUT, Arc::clone(&WIN_INIT_SEMAPHORE).acquire_owned()) => {
				res.map_err(|_| Error::msg("Windows session initialization worker pool saturated"))?
					.map_err(|err| Error::msg(format!("Windows session initialization semaphore closed: {err}")))?
			}
		}
	} else {
		tokio::time::timeout(WIN_INIT_ACQUIRE_TIMEOUT, Arc::clone(&WIN_INIT_SEMAPHORE).acquire_owned())
			.await
			.map_err(|_| Error::msg("Windows session initialization worker pool saturated"))?
			.map_err(|err| Error::msg(format!("Windows session initialization semaphore closed: {err}")))?
	};
	let cancel_flag = Arc::new(AtomicBool::new(false));
	let thread_cancel = Arc::clone(&cancel_flag);

	let (tx, rx) = oneshot::channel();
	thread::Builder::new()
		.name("veyyon-win-init".into())
		.spawn(move || {
			let _permit = permit;
			let mut expanded_temps = Vec::with_capacity(temp_vars.len());
			for (key, value) in temp_vars {
				if thread_cancel.load(Ordering::Relaxed) {
					let _ = tx.send(Err(Error::msg("Windows session initialization cancelled")));
					return;
				}
				if let Ok(expanded) = brush_core::sys::fs::expand_to_long_path(Path::new(&value))
					.into_os_string()
					.into_string()
					&& expanded != value
				{
					expanded_temps.push((key, expanded));
				}
			}
			let updated_path =
				resolve_windows_path(&existing_path, Some(&thread_cancel), hook_key.as_deref());
			let _ = tx.send(updated_path.map(|path| (expanded_temps, path)));
		})
		.map_err(|err| Error::msg(format!("Failed to spawn Windows session init thread: {err}")))?;

	let (expanded_temps, updated_path) = if let Some(token) = cancel_token {
		tokio::select! {
			biased;
			() = token.cancelled() => {
				cancel_flag.store(true, Ordering::Relaxed);
				return Err(Error::msg("Windows session initialization cancelled"));
			},
			res = rx => res.map_err(|_| Error::msg("Windows session init thread exited unexpectedly"))??,
		}
	} else {
		rx.await
			.map_err(|_| Error::msg("Windows session init thread exited unexpectedly"))??
	};

	for (key, expanded) in expanded_temps {
		let mut var = ShellVariable::new(ShellValue::String(expanded));
		var.export();
		shell
			.env_mut()
			.set_global(key, var)
			.map_err(|err| Error::msg(format!("Failed to set env: {err}")))?;
	}

	if let Some(updated_path) = updated_path {
		apply_updated_path(shell, updated_path)?;
	}
	Ok(())
}
pub(crate) fn existing_shell_path(shell: &BrushShell) -> String {
	shell
		.env()
		.get("PATH")
		.and_then(|(_, var)| match var.value() {
			ShellValue::String(value) => Some(value.clone()),
			_ => None,
		})
		.unwrap_or_default()
}

pub(crate) fn apply_updated_path(shell: &mut BrushShell, updated_path: String) -> Result<()> {
	let mut var = ShellVariable::new(ShellValue::String(updated_path));
	var.export();
	shell
		.env_mut()
		.set_global("PATH", var)
		.map_err(|err| Error::msg(format!("Failed to set PATH: {err}")))
}

#[cfg(test)]
pub(crate) fn test_hook_key(shell: &BrushShell) -> Option<String> {
	shell
		.env()
		.get("VEYYON_TEST_BLOCK_WIN_INIT")
		.and_then(|(_, var)| match var.value() {
			ShellValue::String(value) => Some(value.clone()),
			_ => None,
		})
}

#[cfg(not(test))]
pub(crate) const fn test_hook_key(_shell: &BrushShell) -> Option<String> {
	None
}

pub(crate) fn resolve_windows_path(
	existing_path: &str,
	cancel: Option<&AtomicBool>,
	#[allow(unused_variables, reason = "hook_key is used only in #[cfg(test)] builds")]
	hook_key: Option<&str>,
) -> Result<Option<String>> {
	#[cfg(test)]
	test_hooks::run_if_present(hook_key);

	if is_cancelled(cancel) {
		return Err(Error::msg("Windows path initialization cancelled"));
	}

	let git_env = discover_git_environment(cancel);
	if is_cancelled(cancel) {
		return Err(Error::msg("Windows path initialization cancelled"));
	}

	if git_env.install_roots.is_empty() && git_env.git_paths.is_empty() {
		return Ok(None);
	}

	// Translate MSYS2-style entries (e.g. /usr/bin, /mingw64/bin, /c/Users/...)
	// into Windows-native paths so brush-core's std::path-based lookups can
	// resolve executables shipped with Git Bash.
	let mut segments: Vec<String> = Vec::new();
	let mut seen_normalized: HashSet<String> = HashSet::new();
	for raw in env::split_paths(existing_path) {
		if is_cancelled(cancel) {
			return Err(Error::msg("Windows path initialization cancelled"));
		}
		let raw_str = raw.to_string_lossy().into_owned();
		if raw_str.trim().is_empty() {
			continue;
		}
		let translated = translate_msys_segment(&raw_str, &git_env.install_roots).unwrap_or(raw_str);
		let normalized = normalize_path(Path::new(&translated));
		if normalized.is_empty() {
			segments.push(translated);
			continue;
		}
		if !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(translated);
	}

	for git_path in &git_env.git_paths {
		if is_cancelled(cancel) {
			return Err(Error::msg("Windows path initialization cancelled"));
		}
		let normalized = normalize_path(Path::new(git_path));
		if normalized.is_empty() || !seen_normalized.insert(normalized) {
			continue;
		}
		segments.push(git_path.clone());
	}

	let updated_path = segments.join(";");
	if updated_path == existing_path {
		Ok(None)
	} else {
		Ok(Some(updated_path))
	}
}

fn is_cancelled(cancel: Option<&AtomicBool>) -> bool {
	cancel.is_some_and(|flag| flag.load(Ordering::Relaxed))
}

/// Lexical Windows path normalization for `PATH` deduplication without calling
/// `canonicalize()`, which opens directory handles and can stall indefinitely
/// on offline UNC shares or disconnected network drives.
fn normalize_path(path: &Path) -> String {
	let path_str = path.to_string_lossy();
	let unquoted = path_str.trim().trim_matches('"');
	if unquoted.is_empty() {
		return String::new();
	}

	let slash_normalized = unquoted.replace('/', "\\");
	let mut normalized = PathBuf::new();
	for component in Path::new(&slash_normalized).components() {
		normalized.push(component.as_os_str());
	}

	normalized.to_string_lossy().to_ascii_lowercase()
}

fn discover_git_environment(cancel: Option<&AtomicBool>) -> GitEnvironment {
	struct InFlightGuard;
	impl Drop for InFlightGuard {
		fn drop(&mut self) {
			let (lock, cvar) = &*GIT_ENV_CACHE;
			if let Ok(mut state) = lock.lock() {
				state.in_flight = false;
				cvar.notify_all();
			}
		}
	}

	let host_path = env::var_os("PATH");
	let (lock, cvar) = &*GIT_ENV_CACHE;
	let mut is_leader = false;
	if let Ok(mut state) = lock.lock() {
		loop {
			if let Some((cached_path, cached_at, cached_env)) = state.cached.as_ref()
				&& *cached_path == host_path
				&& cached_at.elapsed() < GIT_ENV_CACHE_TTL
			{
				return cached_env.clone();
			}
			if is_cancelled(cancel) {
				return GitEnvironment::default();
			}
			if !state.in_flight {
				state.in_flight = true;
				is_leader = true;
				break;
			}
			let Ok((next, _)) = cvar.wait_timeout(state, WHERE_POLL_INTERVAL) else {
				return GitEnvironment::default();
			};
			state = next;
		}
	}
	let _leader_guard = is_leader.then_some(InFlightGuard);

	let mut install_roots = Vec::new();
	let mut seen_roots = HashSet::new();
	let reg_root = query_git_install_path_from_registry();
	let (where_root, where_completed) = query_git_install_path_from_where(cancel);

	for install_path in [reg_root, where_root].into_iter().flatten() {
		let path = PathBuf::from(&install_path);
		let normalized = normalize_path(&path);
		if !normalized.is_empty() && seen_roots.insert(normalized) {
			install_roots.push(path);
		}
	}

	let mut git_paths = Vec::new();
	let mut seen_paths = HashSet::new();
	for root in &install_roots {
		if is_cancelled(cancel) {
			break;
		}
		for candidate in git_paths_for_install_root(root) {
			let normalized = normalize_path(Path::new(&candidate));
			if !normalized.is_empty() && seen_paths.insert(normalized) {
				git_paths.push(candidate);
			}
		}
	}

	let discovered = GitEnvironment { install_roots, git_paths };
	if is_leader
		&& where_completed
		&& !is_cancelled(cancel)
		&& let Ok(mut state) = lock.lock()
	{
		state.cached = Some((host_path, Instant::now(), discovered.clone()));
	}
	discovered
}

fn query_git_install_path_from_registry() -> Option<String> {
	let hklm = RegKey::predef(HKEY_LOCAL_MACHINE);
	let key_paths = ["SOFTWARE\\GitForWindows", "SOFTWARE\\WOW6432Node\\GitForWindows"];

	for key_path in key_paths {
		if let Ok(key) = hklm.open_subkey(key_path)
			&& let Ok(path) = key.get_value::<String, _>("InstallPath")
			&& !path.is_empty()
		{
			return Some(path);
		}
	}

	None
}

/// Runs `where git` once with a bounded wait and cancellation polling.
/// Returns `(discovered_root, completed_cleanly)` so cancelled/timed-out runs
/// are never cached.
fn drain_where_stdout(mut stdout: impl std::io::Read) -> String {
	let mut buf = Vec::with_capacity(512);
	let mut chunk = [0u8; 512];
	loop {
		match stdout.read(&mut chunk) {
			Ok(0) | Err(_) => break,
			Ok(n) => {
				if buf.len() < MAX_WHERE_STDOUT_BYTES {
					let keep = n.min(MAX_WHERE_STDOUT_BYTES - buf.len());
					buf.extend_from_slice(&chunk[..keep]);
				}
			},
		}
	}
	String::from_utf8_lossy(&buf).into_owned()
}

fn query_git_install_path_from_where(cancel: Option<&AtomicBool>) -> (Option<String>, bool) {
	if is_cancelled(cancel) {
		return (None, false);
	}

	const CREATE_NO_WINDOW: u32 = 0x0800_0000;
	let Ok(mut child) = Command::new("where")
		.arg("git")
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.creation_flags(CREATE_NO_WINDOW)
		.spawn()
	else {
		return (None, true);
	};

	let stdout_handle = child.stdout.take().map(|stdout| {
		thread::Builder::new()
			.name("veyyon-where-git-stdout".into())
			.spawn(move || drain_where_stdout(stdout))
	});

	let deadline = Instant::now() + WHERE_GIT_TIMEOUT;
	let status = loop {
		if is_cancelled(cancel) || Instant::now() >= deadline {
			let _ = child.kill();
			let _ = child.wait();
			return (None, false);
		}
		match child.try_wait() {
			Ok(Some(status)) => break status,
			Ok(None) => thread::sleep(WHERE_POLL_INTERVAL),
			Err(_) => {
				let _ = child.kill();
				let _ = child.wait();
				return (None, false);
			},
		}
	};

	if !status.success() {
		return (None, true);
	}

	let stdout_buf = match stdout_handle {
		Some(Ok(handle)) => {
			let mut finished = handle.is_finished();
			while !finished {
				if is_cancelled(cancel) || Instant::now() >= deadline {
					return (None, false);
				}
				thread::sleep(WHERE_POLL_INTERVAL);
				finished = handle.is_finished();
			}
			handle.join().unwrap_or_default()
		},
		_ => String::new(),
	};
	let Some(line) = stdout_buf.lines().next().map(str::trim).filter(|s| !s.is_empty()) else {
		return (None, true);
	};
	let git_path = Path::new(line);
	let root = git_install_root_from_path(git_path)
		.map(|install_root| install_root.to_string_lossy().into_owned());
	(root, true)
}
fn git_install_root_from_path(git_path: &Path) -> Option<PathBuf> {
	let parent = git_path.parent()?;
	let parent_name = parent.file_name()?.to_string_lossy();

	if parent_name.eq_ignore_ascii_case("cmd") {
		return parent.parent().map(Path::to_path_buf);
	}

	if parent_name.eq_ignore_ascii_case("bin") {
		let grandparent = parent.parent()?;
		if let Some(grandparent_name) = grandparent.file_name() {
			let grandparent_name = grandparent_name.to_string_lossy();
			if grandparent_name.eq_ignore_ascii_case("usr")
				|| grandparent_name.eq_ignore_ascii_case("mingw64")
				|| grandparent_name.eq_ignore_ascii_case("mingw32")
			{
				return grandparent.parent().map(Path::to_path_buf);
			}
		}
		return Some(grandparent.to_path_buf());
	}

	parent.parent().map(Path::to_path_buf)
}

fn git_paths_for_install_root(root: &Path) -> Vec<String> {
	let mut paths = Vec::new();

	let cmd = root.join("cmd");
	if has_git_command(&cmd) {
		paths.push(cmd.to_string_lossy().into_owned());
	}

	let bin = root.join("bin");
	if has_git_command(&bin) {
		paths.push(bin.to_string_lossy().into_owned());
	}

	let usr_bin = root.join("usr").join("bin");
	if has_git_command(&usr_bin) || usr_bin.join("ls.exe").is_file() {
		paths.push(usr_bin.to_string_lossy().into_owned());
	}

	paths
}

fn has_git_command(dir: &Path) -> bool {
	if !dir.is_dir() {
		return false;
	}

	["git.exe", "git.cmd", "git.bat"]
		.iter()
		.any(|name| dir.join(name).is_file())
}

/// Translate an MSYS2/Git Bash style path entry (e.g. `/usr/bin`,
/// `/mingw64/bin`, `/c/Users/foo`) into a Windows-native path so that
/// `std::path` based executable lookups in brush-core can resolve binaries
/// shipped with Git Bash. Returns `None` when the segment is already a
/// Windows-style path or cannot be translated.
fn translate_msys_segment(segment: &str, install_roots: &[PathBuf]) -> Option<String> {
	let trimmed = segment.trim().trim_matches('"');
	if trimmed.is_empty() || is_windows_style_path(trimmed) {
		return None;
	}

	let forward = trimmed.replace('\\', "/");
	if !forward.starts_with('/') {
		return None;
	}

	// MSYS drive-letter mapping: /c -> C:\, /c/Users/foo -> C:\Users\foo.
	let rest = &forward[1..];
	if let Some((head, tail)) = rest.split_once('/') {
		if is_drive_letter(head) {
			let drive = head.to_ascii_uppercase();
			let windows_tail = tail.replace('/', "\\");
			return Some(format!("{drive}:\\{windows_tail}"));
		}
	} else if is_drive_letter(rest) {
		return Some(format!("{}:\\", rest.to_ascii_uppercase()));
	}

	// Anchor the remainder against any known Git/MSYS install root.
	let relative = rest.replace('/', "\\");
	for root in install_roots {
		let candidate = root.join(&relative);
		if candidate.is_dir() {
			return Some(candidate.to_string_lossy().into_owned());
		}
	}

	None
}

fn is_drive_letter(value: &str) -> bool {
	value.len() == 1
		&& value
			.chars()
			.next()
			.is_some_and(|c| c.is_ascii_alphabetic())
}

fn is_windows_style_path(value: &str) -> bool {
	let bytes = value.as_bytes();
	if bytes.len() >= 2 && bytes[1] == b':' && bytes[0].is_ascii_alphabetic() {
		return true;
	}
	value.starts_with("\\\\")
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn drive_letter_segments_translate_to_windows_paths() {
		assert_eq!(translate_msys_segment("/c/Users/foo", &[]).as_deref(), Some("C:\\Users\\foo"),);
		assert_eq!(translate_msys_segment("/d", &[]).as_deref(), Some("D:\\"),);
	}

	#[test]
	fn windows_style_segments_are_left_alone() {
		assert_eq!(translate_msys_segment("C:\\Windows\\System32", &[]), None);
		assert_eq!(translate_msys_segment("\\\\server\\share", &[]), None);
		assert_eq!(translate_msys_segment("relative\\path", &[]), None);
	}

	#[test]
	fn is_drive_letter_only_matches_single_alphabetic_chars() {
		assert!(is_drive_letter("c"));
		assert!(is_drive_letter("Z"));
		assert!(!is_drive_letter(""));
		assert!(!is_drive_letter("cc"));
		assert!(!is_drive_letter("1"));
	}

	#[test]
	fn normalize_path_handles_slashes_quotes_and_unc_lexically() {
		assert_eq!(
			normalize_path(Path::new(r#""C:/Program Files/Git/cmd/""#)),
			normalize_path(Path::new(r"c:\program files\git\cmd"))
		);
		assert_eq!(
			normalize_path(Path::new(r"\\offline-server\share\bin")),
			r"\\offline-server\share\bin"
		);
	}

	#[test]
	fn drain_where_stdout_drains_past_cap_without_closing_pipe() {
		use std::io::Write;
		let (reader, mut writer) = std::io::pipe().expect("pipe");
		let total = MAX_WHERE_STDOUT_BYTES + 8192;
		let writer_thread = thread::spawn(move || {
			let payload = vec![b'a'; total];
			writer.write_all(&payload)
		});
		let captured = drain_where_stdout(reader);
		let write_res = writer_thread.join().expect("writer thread");
		assert!(write_res.is_ok(), "writer must not hit BrokenPipe: {write_res:?}");
		assert_eq!(captured.len(), MAX_WHERE_STDOUT_BYTES);
	}
}

#[cfg(test)]
pub(crate) mod test_hooks {
	use std::{
		collections::HashMap,
		sync::{Arc, LazyLock, Mutex},
	};

	type HookFn = Arc<dyn Fn() + Send + Sync>;

	static HOOKS: LazyLock<Mutex<HashMap<String, HookFn>>> =
		LazyLock::new(|| Mutex::new(HashMap::new()));

	pub(crate) struct HookGuard {
		key: String,
	}

	impl Drop for HookGuard {
		fn drop(&mut self) {
			if let Ok(mut guard) = HOOKS.lock() {
				guard.remove(&self.key);
			}
		}
	}

	pub(crate) fn install(key: impl Into<String>, hook: HookFn) -> HookGuard {
		let key = key.into();
		HOOKS.lock().expect("hook lock").insert(key.clone(), hook);
		HookGuard { key }
	}

	pub(crate) fn run_if_present(key: Option<&str>) {
		let Some(key) = key else {
			return;
		};
		let hook = HOOKS.lock().ok().and_then(|guard| guard.get(key).cloned());
		if let Some(hook) = hook {
			hook();
		}
	}
}
