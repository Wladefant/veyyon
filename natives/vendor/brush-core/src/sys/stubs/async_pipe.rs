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

		let (tx, rx) = tokio::sync::oneshot::channel();
		std::thread::Builder::new()
			.name("brush-async-pipe".into())
			.spawn(move || {
				let mut s = String::new();
				let res = reader.read_to_string(&mut s).map(|_| s);
				let _ = tx.send(res);
			})
			.map_err(io::Error::other)?;

		rx.await.map_err(io::Error::other)?
	}
}
