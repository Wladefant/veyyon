//! Async pipe reading utilities for non-Unix platforms.
//!
//! Uses an independent OS thread instead of `tokio::task::spawn_blocking` so
//! command substitutions never starve behind a saturated Tokio blocking pool.

use std::io::{self, Read};

pub(crate) struct AsyncPipeReader {
	inner: Option<std::io::PipeReader>,
}

impl AsyncPipeReader {
	pub(crate) fn new(fd: std::io::PipeReader) -> io::Result<Self> {
		Ok(Self { inner: Some(fd) })
	}

	pub(crate) async fn read_to_string(&mut self) -> io::Result<String> {
		let Some(mut reader) = self.inner.take() else {
			return Ok(String::new());
		};

		#[cfg(windows)]
		{
			use std::os::windows::io::AsRawHandle;
			const ERROR_BROKEN_PIPE: u32 = 109;
			const ERROR_NO_DATA: u32 = 232;
			const ERROR_PIPE_NOT_CONNECTED: u32 = 233;
			unsafe extern "system" {
				fn PeekNamedPipe(
					h_named_pipe: *mut std::ffi::c_void,
					lp_buffer: *mut std::ffi::c_void,
					n_buffer_size: u32,
					lp_bytes_read: *mut u32,
					lp_total_bytes_avail: *mut u32,
					lp_bytes_left_this_message: *mut u32,
				) -> i32;
				fn GetLastError() -> u32;
			}

			let mut out = Vec::new();
			let mut buf = [0u8; 8192];
			let mut not_a_pipe = false;
			loop {
				let mut bytes_avail = 0u32;
				// SAFETY: `reader` is an open pipe handle and `bytes_avail` is a valid local u32.
				let ok = unsafe {
					PeekNamedPipe(
						reader.as_raw_handle(),
						std::ptr::null_mut(),
						0,
						std::ptr::null_mut(),
						&mut bytes_avail,
						std::ptr::null_mut(),
					)
				};
				if ok != 0 {
					if bytes_avail > 0 {
						let to_read = (bytes_avail as usize).min(buf.len());
						match reader.read(&mut buf[..to_read]) {
							Ok(0) => break,
							Ok(n) => out.extend_from_slice(&buf[..n]),
							Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
							Err(e) if e.kind() == io::ErrorKind::BrokenPipe => break,
							Err(e) => return Err(e),
						}
					} else {
						tokio::time::sleep(std::time::Duration::from_millis(5)).await;
					}
				} else {
					// SAFETY: FFI call to read thread-local Win32 error code immediately after PeekNamedPipe.
					let err = unsafe { GetLastError() };
					if matches!(err, ERROR_BROKEN_PIPE | ERROR_PIPE_NOT_CONNECTED | ERROR_NO_DATA) {
						break;
					}
					not_a_pipe = true;
					break;
				}
			}
			if !not_a_pipe {
				return String::from_utf8(out)
					.map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e));
			}
		}

		#[cfg(not(windows))]
		{
			let handle = tokio::task::spawn_blocking(move || {
				let mut s = String::new();
				reader.read_to_string(&mut s).map(|_| s)
			});
			return handle.await.map_err(io::Error::other)?;
		}

		#[cfg(windows)]
		{
			static ASYNC_PIPE_SEMAPHORE: std::sync::LazyLock<
				std::sync::Arc<tokio::sync::Semaphore>,
			> = std::sync::LazyLock::new(|| std::sync::Arc::new(tokio::sync::Semaphore::new(32)));
			let permit = std::sync::Arc::clone(&ASYNC_PIPE_SEMAPHORE)
				.acquire_owned()
				.await
				.map_err(io::Error::other)?;
			let (tx, rx) = tokio::sync::oneshot::channel();
			let join_handle = std::thread::Builder::new()
				.name("brush-async-pipe".into())
				.spawn(move || {
					let _permit = permit;
					let mut s = String::new();
					let res = reader.read_to_string(&mut s).map(|_| s);
					let _ = tx.send(res);
				})
				.map_err(io::Error::other)?;

			struct CancelOnDrop(Option<std::thread::JoinHandle<()>>);
			impl Drop for CancelOnDrop {
				fn drop(&mut self) {
					if let Some(handle) = self.0.take() {
						use std::os::windows::io::AsRawHandle;
						unsafe extern "system" {
							fn CancelSynchronousIo(h_thread: *mut std::ffi::c_void) -> i32;
						}
						// SAFETY: `handle` is a live thread handle until dropped.
						unsafe {
							CancelSynchronousIo(handle.as_raw_handle());
						}
					}
				}
			}
			let mut cancel_guard = CancelOnDrop(Some(join_handle));
			let res = rx.await.map_err(io::Error::other)?;
			cancel_guard.0 = None;
			res
		}
	}
}
