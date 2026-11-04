//! WHY: reading redirected input must not change the host process's console modes.
//!
//! Each case runs the builtin through [`Shell::run`] with file-backed stdin.
//! Exact captured output also rejects shell error messages on the output stream.
//! Reproduce the hidden-console guard with `python natives/shell/tests/support/hidden_console.py cargo test -p veyyon-shell --test a_redirected_read_does_not_change_console_modes`.

use std::fs;

use veyyon_shell::{Shell, ShellRunOptions, cancel::CancelToken};
use veyyon_test_scratch::{TempTree, scratch_dir};

#[cfg(windows)]
mod console_fixture {
	use std::{fs::OpenOptions, os::windows::io::AsRawHandle};

	use std::sync::{Mutex, MutexGuard};

	static SERIAL: Mutex<()> = Mutex::new(());
	const STD_INPUT_HANDLE: u32 = (-10_i32) as u32;
	const STD_OUTPUT_HANDLE: u32 = (-11_i32) as u32;
	const STD_ERROR_HANDLE: u32 = (-12_i32) as u32;

	#[link(name = "kernel32")]
	unsafe extern "system" {
		fn GetStdHandle(kind: u32) -> *mut core::ffi::c_void;
		fn SetStdHandle(kind: u32, handle: *mut core::ffi::c_void) -> i32;
	}

	pub struct ConsoleHandles {
		_guard: MutexGuard<'static, ()>,
		old: [*mut core::ffi::c_void; 3],
		_input: std::fs::File,
		_output: std::fs::File,
	}

	impl ConsoleHandles {
		pub fn attach() -> Option<Self> {
			let guard = SERIAL.lock().unwrap_or_else(|poison| poison.into_inner());
			// The parent creates a hidden console for this test process.
			let Ok(input) = OpenOptions::new().read(true).write(true).open("CONIN$") else {
				assert_ne!(std::env::var_os("VEYYON_READ_REQUIRE_CONSOLE"), Some("1".into()), "required console unavailable");
				return None;
			};
			let Ok(output) = OpenOptions::new().read(true).write(true).open("CONOUT$") else {
				assert_ne!(std::env::var_os("VEYYON_READ_REQUIRE_CONSOLE"), Some("1".into()), "required console unavailable");
				return None;
			};
			// SAFETY: these kernel32 calls query and update this process's standard handles.
			let old = unsafe {
				[
					GetStdHandle(STD_INPUT_HANDLE),
					GetStdHandle(STD_OUTPUT_HANDLE),
					GetStdHandle(STD_ERROR_HANDLE),
				]
			};
			// SAFETY: input/output handles remain open for the guard lifetime.
			unsafe {
				assert_ne!(SetStdHandle(STD_INPUT_HANDLE, input.as_raw_handle().cast()), 0);
				assert_ne!(SetStdHandle(STD_OUTPUT_HANDLE, output.as_raw_handle().cast()), 0);
				assert_ne!(SetStdHandle(STD_ERROR_HANDLE, output.as_raw_handle().cast()), 0);
			}
			Some(Self { _guard: guard, old, _input: input, _output: output })
		}
	}

	impl Drop for ConsoleHandles {
		fn drop(&mut self) {
			// SAFETY: restore the process handles saved before this fixture changed them.
			unsafe {
				SetStdHandle(STD_INPUT_HANDLE, self.old[0]);
				SetStdHandle(STD_OUTPUT_HANDLE, self.old[1]);
				SetStdHandle(STD_ERROR_HANDLE, self.old[2]);
			}
		}
	}
}

fn input_file(name: &str, contents: &[u8]) -> TempTree {
	let root = scratch_dir(name);
	fs::write(root.path().join("input.txt"), contents).expect("write input");
	root
}

async fn run(root: &TempTree, command: String) -> (Option<i32>, String) {
	#[cfg(windows)]
	let _console = console_fixture::ConsoleHandles::attach();
	let shell = Shell::new(None);
	let (tx, rx) = flume::unbounded::<String>();
	let result = shell
		.run(
			ShellRunOptions {
				command,
				cwd: Some(root.path().to_string_lossy().into_owned()),
				..ShellRunOptions::default()
			},
			Some(tx),
			CancelToken::default(),
		)
		.await
		.expect("shell run");
	(result.exit_code, rx.drain().collect())
}

fn read_command() -> String {
	"read -r a b < input.txt; printf '%s:%s:%s\\n' \"$?\" \"$a\" \"$b\"".to_owned()
}

#[tokio::test(flavor = "multi_thread")]
async fn lf_read_preserves_value_and_has_no_error() {
	let root = input_file("redirected-read-lf", b"123 4\n");
	let (status, output) = run(&root, read_command()).await;
	assert_eq!(status, Some(0));
	assert_eq!(output, "0:123:4\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn crlf_read_preserves_carriage_return_and_has_no_error() {
	let root = input_file("redirected-read-crlf", b"123 4\r\n");
	let (status, output) = run(&root, read_command()).await;
	assert_eq!(status, Some(0));
	assert_eq!(output, "0:123:4\r\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn no_newline_read_preserves_value_and_status() {
	let root = input_file("redirected-read-no-newline", b"123 4");
	let (status, output) = run(&root, read_command()).await;
	assert_eq!(status, Some(0));
	assert_eq!(output, "1:123:4\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn eof_returns_one_after_assigning_empty_variables() {
	let root = input_file("redirected-read-eof", b"");
	let (status, output) = run(&root, read_command()).await;
	assert_eq!(status, Some(0));
	assert_eq!(output, "1::\n");
}

#[tokio::test(flavor = "multi_thread")]
async fn sourced_function_reads_its_redirected_input() {
	let root = scratch_dir("redirected-read-sourced-function");
	fs::write(root.path().join("input.txt"), b"123 4\n").expect("write input");
	fs::write(
		root.path().join("read.sh"),
		b"show() { read -r a b < input.txt; printf '%s:%s:%s\\n' \"$?\" \"$a\" \"$b\"; }\n",
	)
	.expect("write function");
	let (status, output) = run(&root, "source read.sh; show".to_owned()).await;
	assert_eq!(status, Some(0));
	assert_eq!(output, "0:123:4\n");
}
