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

		#[cfg(windows)]
		struct CancelOnDrop(Option<std::thread::JoinHandle<()>>);
		#[cfg(windows)]
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
		#[cfg(windows)]
		let mut cancel_guard = CancelOnDrop(Some(join_handle));

		let res = rx.await.map_err(io::Error::other)?;
		#[cfg(windows)]
		{
			cancel_guard.0 = None;
		}
		res
	}
}
