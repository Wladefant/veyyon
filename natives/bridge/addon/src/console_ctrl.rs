//! Native Windows console control event diagnostics.
//!
//! Registers a `HandlerRoutine` callback with `SetConsoleCtrlHandler` to record
//! terminal console control signals (`CTRL_CLOSE_EVENT`, `CTRL_LOGOFF_EVENT`,
//! `CTRL_SHUTDOWN_EVENT`) to a per-process log file synchronously before
//! the process terminates.
//!
//! # Platform behavior and constraints
//! - When Windows sends a control event, it spawns a dedicated handler thread in
//!   the target process. The callback executes on this native OS thread; it MUST
//!   NOT call into JavaScript or the V8/Bun engine.
//! - The handler synchronously appends a structured JSON line record to the
//!   configured target file, flushes it to disk (`flush` + `sync_data`), and returns
//!   `FALSE` (0). Returning `FALSE` allows subsequent handlers and the default
//!   handler (which calls `ExitProcess`) to run, preserving default OS process termination.
//! - Per Microsoft documentation (<https://learn.microsoft.com/en-us/windows/console/handlerroutine>),
//!   `CTRL_LOGOFF_EVENT` and `CTRL_SHUTDOWN_EVENT` are generally delivered only to services;
//!   interactive applications may be terminated earlier by Windows, and loading
//!   `gdi32.dll` or `user32.dll` causes Windows to treat the process as a GUI app and
//!   suppress console logoff/shutdown signals. We record these events if received, but
//!   do not claim unreceived events are observable.
//! - On non-Windows platforms, console control handling is unsupported; `installConsoleCtrlHandler`
//!   returns `{ installed: false, supported: false, path: None, status: "unsupported_platform" }`.

use std::{
	io::Write,
	path::Path,
	time::{SystemTime, UNIX_EPOCH},
};

use napi_derive::napi;

/// Control event type: CTRL+C signal (0). Ignored by recorder.
pub const CTRL_C_EVENT: u32 = 0;
/// Control event type: CTRL+BREAK signal (1). Ignored by recorder.
pub const CTRL_BREAK_EVENT: u32 = 1;
/// Control event type: Console window closed or End Task (2). Recorded.
pub const CTRL_CLOSE_EVENT: u32 = 2;
/// Control event type: User logging off (5). Recorded when delivered.
pub const CTRL_LOGOFF_EVENT: u32 = 5;
/// Control event type: System shutting down (6). Recorded when delivered.
pub const CTRL_SHUTDOWN_EVENT: u32 = 6;

/// Maps a Windows console control event type to its symbolic name,
/// returning `Some` only for the terminal events we record (2, 5, 6).
pub fn ctrl_type_name(ctrl_type: u32) -> Option<&'static str> {
	match ctrl_type {
		CTRL_CLOSE_EVENT => Some("CTRL_CLOSE_EVENT"),
		CTRL_LOGOFF_EVENT => Some("CTRL_LOGOFF_EVENT"),
		CTRL_SHUTDOWN_EVENT => Some("CTRL_SHUTDOWN_EVENT"),
		_ => None,
	}
}

/// Returns true if the control event is one of the terminal events we record.
pub const fn is_recorded_event(ctrl_type: u32) -> bool {
	matches!(ctrl_type, CTRL_CLOSE_EVENT | CTRL_LOGOFF_EVENT | CTRL_SHUTDOWN_EVENT)
}

/// Result of installing the console control event recorder.
#[napi(object, js_name = "ConsoleCtrlInstallResult")]
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleCtrlInstallResult {
	/// True if the handler is installed and actively recording.
	pub installed: bool,
	/// True if this platform supports Windows console control events.
	pub supported: bool,
	/// File path where console control events are logged, if installed.
	pub path: Option<String>,
	/// Status code or description: "installed", "reinstalled", "empty_path", "unsupported_platform", or error message.
	pub status: String,
}

/// Structured record written to disk when a console control signal is received.
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConsoleCtrlRecord {
	/// Symbolic event name (e.g. "CTRL_CLOSE_EVENT").
	pub event: String,
	/// Numeric control event identifier (e.g. 2 for CTRL_CLOSE_EVENT).
	pub ctrl_type: u32,
	/// Process ID of the process that received the event.
	pub pid: u32,
	/// Unix timestamp in milliseconds when the event was recorded.
	pub timestamp_ms: u64,
}

fn unix_millis() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |d| d.as_millis() as u64)
}

/// Formats a console control event into a JSONL string ending with newline.
/// Returns `None` if `ctrl_type` is not one of the recorded events (2, 5, 6).
pub fn format_console_ctrl_event(ctrl_type: u32, pid: u32, timestamp_ms: u64) -> Option<String> {
	let event_name = ctrl_type_name(ctrl_type)?;
	let record = ConsoleCtrlRecord {
		event: event_name.to_string(),
		ctrl_type,
		pid,
		timestamp_ms,
	};
	serde_json::to_string(&record).ok().map(|mut s| {
		s.push('\n');
		s
	})
}

/// Synchronously appends the formatted console event record to `path` and flushes to disk.
///
/// Returns `Ok(true)` if recorded, `Ok(false)` if the event is ignored, or `Err` on I/O error.
pub fn write_console_ctrl_event_to_file(path: &Path, ctrl_type: u32) -> std::io::Result<bool> {
	let pid = std::process::id();
	let timestamp_ms = unix_millis();
	let Some(line) = format_console_ctrl_event(ctrl_type, pid, timestamp_ms) else {
		return Ok(false);
	};

	if let Some(parent) = path.parent() {
		let _ = std::fs::create_dir_all(parent);
	}

	let mut file = std::fs::OpenOptions::new()
		.create(true)
		.append(true)
		.open(path)?;
	file.write_all(line.as_bytes())?;
	file.flush()?;
	let _ = file.sync_data();
	Ok(true)
}

#[cfg(test)]
pub(crate) fn simulate_console_ctrl_event(path: &Path, ctrl_type: u32) -> std::io::Result<bool> {
	write_console_ctrl_event_to_file(path, ctrl_type)
}

/// Install native Windows console event recorder.
///
/// Registers a `SetConsoleCtrlHandler` callback to synchronously append
/// `CTRL_CLOSE_EVENT` (2), `CTRL_LOGOFF_EVENT` (5), and `CTRL_SHUTDOWN_EVENT` (6)
/// to `path` before returning `FALSE`.
#[napi(js_name = "installConsoleCtrlHandler")]
pub fn install_console_ctrl_handler(path: String) -> ConsoleCtrlInstallResult {
	platform::install(path)
}

/// Remove the native console control event recorder.
#[napi(js_name = "removeConsoleCtrlHandler")]
pub fn remove_console_ctrl_handler() -> bool {
	platform::remove()
}
#[cfg(windows)]
mod platform {
	use super::*;
	use std::{
		path::PathBuf,
		sync::Arc,
		time::Duration,
	};
	use windows_sys::Win32::System::Console::SetConsoleCtrlHandler;

	struct State {
		installed_path: Option<Arc<PathBuf>>,
		registered: bool,
	}

	static STATE: parking_lot::RwLock<State> = parking_lot::RwLock::new(State {
		installed_path: None,
		registered: false,
	});

	/// Native HandlerRoutine callback called by Windows on a dedicated OS thread.
	///
	/// CRITICAL:
	/// 1. Must NEVER call JavaScript runtime or allocate in a way that can deadlock.
	/// 2. Must NEVER panic across the FFI boundary (wrapped in catch_unwind).
	/// 3. Returns 0 (FALSE) to allow other handlers and default ExitProcess to run.
	unsafe extern "system" fn console_ctrl_handler(ctrl_type: u32) -> windows_sys::core::BOOL {
		if !is_recorded_event(ctrl_type) {
			return 0; // FALSE: pass unhandled to next handler
		}

		let _ = std::panic::catch_unwind(|| {
			// Read path with bounded timeout so handler never deadlocks
			let target = {
				if let Some(guard) = STATE.try_read_for(Duration::from_millis(500)) {
					guard.installed_path.clone()
				} else {
					None
				}
			};

			if let Some(path) = target {
				let _ = write_console_ctrl_event_to_file(&path, ctrl_type);
			}
		});

		0 // FALSE: continue to next handler in chain / default handler
	}

	pub fn install(raw_path: String) -> ConsoleCtrlInstallResult {
		let trimmed = raw_path.trim();
		if trimmed.is_empty() {
			return ConsoleCtrlInstallResult {
				installed: false,
				supported: true,
				path: None,
				status: "empty_path".to_string(),
			};
		}

		let path = PathBuf::from(trimmed);
		if let Some(parent) = path.parent() {
			let _ = std::fs::create_dir_all(parent);
		}

		let mut state = STATE.write();
		let was_registered = state.registered;

		if !was_registered {
			let res = unsafe { SetConsoleCtrlHandler(Some(console_ctrl_handler), 1) };
			if res == 0 {
				let err = std::io::Error::last_os_error();
				return ConsoleCtrlInstallResult {
					installed: false,
					supported: true,
					path: None,
					status: format!("SetConsoleCtrlHandler failed: {err}"),
				};
			}
			state.registered = true;
		}

		let normalized_path = path.to_string_lossy().to_string();
		state.installed_path = Some(Arc::new(path));

		ConsoleCtrlInstallResult {
			installed: true,
			supported: true,
			path: Some(normalized_path),
			status: if was_registered {
				"reinstalled".to_string()
			} else {
				"installed".to_string()
			},
		}
	}

	pub fn remove() -> bool {
		let mut state = STATE.write();
		if state.registered {
			let _ = unsafe { SetConsoleCtrlHandler(Some(console_ctrl_handler), 0) };
			state.registered = false;
			state.installed_path = None;
			true
		} else {
			state.installed_path = None;
			false
		}
	}

	#[cfg(test)]
	pub fn get_installed_path() -> Option<PathBuf> {
		STATE.read().installed_path.as_deref().cloned()
	}
}

#[cfg(not(windows))]
mod platform {
	use super::*;
	use std::path::PathBuf;

	pub fn install(_path: String) -> ConsoleCtrlInstallResult {
		ConsoleCtrlInstallResult {
			installed: false,
			supported: false,
			path: None,
			status: "unsupported_platform".to_string(),
		}
	}

	pub fn remove() -> bool {
		false
	}

	#[cfg(test)]
	pub fn get_installed_path() -> Option<PathBuf> {
		None
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	use std::fs;

	#[test]
	fn test_ctrl_type_mapping() {
		assert_eq!(ctrl_type_name(CTRL_CLOSE_EVENT), Some("CTRL_CLOSE_EVENT"));
		assert_eq!(ctrl_type_name(CTRL_LOGOFF_EVENT), Some("CTRL_LOGOFF_EVENT"));
		assert_eq!(ctrl_type_name(CTRL_SHUTDOWN_EVENT), Some("CTRL_SHUTDOWN_EVENT"));
		assert_eq!(ctrl_type_name(CTRL_C_EVENT), None);
		assert_eq!(ctrl_type_name(CTRL_BREAK_EVENT), None);
		assert_eq!(ctrl_type_name(3), None);
		assert_eq!(ctrl_type_name(4), None);
		assert_eq!(ctrl_type_name(7), None);
		assert_eq!(ctrl_type_name(999), None);
	}

	#[test]
	fn test_is_recorded_event() {
		assert!(is_recorded_event(CTRL_CLOSE_EVENT));
		assert!(is_recorded_event(CTRL_LOGOFF_EVENT));
		assert!(is_recorded_event(CTRL_SHUTDOWN_EVENT));
		assert!(!is_recorded_event(CTRL_C_EVENT));
		assert!(!is_recorded_event(CTRL_BREAK_EVENT));
		assert!(!is_recorded_event(3));
		assert!(!is_recorded_event(4));
		assert!(!is_recorded_event(7));
	}

	#[test]
	fn test_format_console_ctrl_event() {
		let pid = 12345;
		let ts = 1762819200123;

		let close_str = format_console_ctrl_event(CTRL_CLOSE_EVENT, pid, ts).expect("should format");
		assert!(close_str.ends_with('\n'));
		let close_record: ConsoleCtrlRecord = serde_json::from_str(close_str.trim()).expect("valid json");
		assert_eq!(close_record.event, "CTRL_CLOSE_EVENT");
		assert_eq!(close_record.ctrl_type, 2);
		assert_eq!(close_record.pid, 12345);
		assert_eq!(close_record.timestamp_ms, 1762819200123);

		let logoff_str = format_console_ctrl_event(CTRL_LOGOFF_EVENT, pid, ts).expect("should format");
		let logoff_record: ConsoleCtrlRecord = serde_json::from_str(logoff_str.trim()).expect("valid json");
		assert_eq!(logoff_record.event, "CTRL_LOGOFF_EVENT");
		assert_eq!(logoff_record.ctrl_type, 5);

		let shutdown_str = format_console_ctrl_event(CTRL_SHUTDOWN_EVENT, pid, ts).expect("should format");
		let shutdown_record: ConsoleCtrlRecord = serde_json::from_str(shutdown_str.trim()).expect("valid json");
		assert_eq!(shutdown_record.event, "CTRL_SHUTDOWN_EVENT");
		assert_eq!(shutdown_record.ctrl_type, 6);

		assert!(format_console_ctrl_event(CTRL_C_EVENT, pid, ts).is_none());
		assert!(format_console_ctrl_event(CTRL_BREAK_EVENT, pid, ts).is_none());
		assert!(format_console_ctrl_event(999, pid, ts).is_none());
	}

	#[test]
	fn test_simulate_write_to_file() {
		let temp_dir = std::env::temp_dir().join(format!("veyyon-console-test-{}", std::process::id()));
		let _ = fs::create_dir_all(&temp_dir);
		let log_file = temp_dir.join("console-events.log");
		let _ = fs::remove_file(&log_file);

		// Writing CTRL_C or CTRL_BREAK should return Ok(false) and not write
		let res_c = simulate_console_ctrl_event(&log_file, CTRL_C_EVENT).expect("sim CTRL_C");
		assert!(!res_c);
		assert!(!log_file.exists());

		let res_break = simulate_console_ctrl_event(&log_file, CTRL_BREAK_EVENT).expect("sim CTRL_BREAK");
		assert!(!res_break);
		assert!(!log_file.exists());

		// Write CTRL_CLOSE_EVENT
		let res_close = simulate_console_ctrl_event(&log_file, CTRL_CLOSE_EVENT).expect("sim CTRL_CLOSE");
		assert!(res_close);
		assert!(log_file.exists());

		// Write CTRL_LOGOFF_EVENT
		let res_logoff = simulate_console_ctrl_event(&log_file, CTRL_LOGOFF_EVENT).expect("sim CTRL_LOGOFF");
		assert!(res_logoff);

		// Write CTRL_SHUTDOWN_EVENT
		let res_shutdown = simulate_console_ctrl_event(&log_file, CTRL_SHUTDOWN_EVENT).expect("sim CTRL_SHUTDOWN");
		assert!(res_shutdown);

		// Read back the file
		let content = fs::read_to_string(&log_file).expect("read log file");
		let lines: Vec<&str> = content.lines().filter(|l| !l.trim().is_empty()).collect();
		assert_eq!(lines.len(), 3);

		let r1: ConsoleCtrlRecord = serde_json::from_str(lines[0]).expect("parse line 0");
		assert_eq!(r1.event, "CTRL_CLOSE_EVENT");
		assert_eq!(r1.ctrl_type, 2);
		assert_eq!(r1.pid, std::process::id());
		assert!(r1.timestamp_ms > 0);

		let r2: ConsoleCtrlRecord = serde_json::from_str(lines[1]).expect("parse line 1");
		assert_eq!(r2.event, "CTRL_LOGOFF_EVENT");
		assert_eq!(r2.ctrl_type, 5);

		let r3: ConsoleCtrlRecord = serde_json::from_str(lines[2]).expect("parse line 2");
		assert_eq!(r3.event, "CTRL_SHUTDOWN_EVENT");
		assert_eq!(r3.ctrl_type, 6);

		let _ = fs::remove_file(&log_file);
		let _ = fs::remove_dir_all(&temp_dir);
	}

	#[test]
	fn test_install_empty_path() {
		let res = install_console_ctrl_handler("".to_string());
		assert!(!res.installed);
		assert_eq!(res.status, "empty_path");
		assert!(res.path.is_none());

		let res2 = install_console_ctrl_handler("   ".to_string());
		assert!(!res2.installed);
		assert_eq!(res2.status, "empty_path");
	}

	#[cfg(windows)]
	#[test]
	fn test_windows_install_and_reinstall_and_remove() {
		let temp_dir = std::env::temp_dir().join(format!("veyyon-ctrl-install-{}", std::process::id()));
		let log1 = temp_dir.join("events1.log").to_string_lossy().to_string();
		let log2 = temp_dir.join("events2.log").to_string_lossy().to_string();

		let res1 = install_console_ctrl_handler(log1.clone());
		assert!(res1.installed);
		assert!(res1.supported);
		assert_eq!(res1.status, "installed");
		assert_eq!(res1.path.as_deref(), Some(log1.as_str()));
		assert_eq!(platform::get_installed_path().as_deref(), Some(std::path::Path::new(&log1)));

		// Reinstall with a new path
		let res2 = install_console_ctrl_handler(log2.clone());
		assert!(res2.installed);
		assert!(res2.supported);
		assert_eq!(res2.status, "reinstalled");
		assert_eq!(res2.path.as_deref(), Some(log2.as_str()));
		assert_eq!(platform::get_installed_path().as_deref(), Some(std::path::Path::new(&log2)));

		// Remove
		assert!(remove_console_ctrl_handler());
		assert_eq!(platform::get_installed_path(), None);
		// Second remove should return false
		assert!(!remove_console_ctrl_handler());

		let _ = fs::remove_dir_all(&temp_dir);
	}

	#[cfg(not(windows))]
	#[test]
	fn test_non_windows_unsupported() {
		let res = install_console_ctrl_handler("/tmp/test.log".to_string());
		assert!(!res.installed);
		assert!(!res.supported);
		assert_eq!(res.status, "unsupported_platform");
		assert!(res.path.is_none());
		assert!(!remove_console_ctrl_handler());
	}
}
