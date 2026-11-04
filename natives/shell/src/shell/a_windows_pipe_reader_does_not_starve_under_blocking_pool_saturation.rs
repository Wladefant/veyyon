//! WHY: On Windows, `read_output`, `read_output_buffered`, and
//! `read_output_bytes` previously wrapped pipes in `tokio::fs::File`, which
//! delegates reads to Tokio's blocking thread pool via `spawn_blocking`. When
//! the blocking pool was saturated (e.g., eight concurrent blocking workers
//! holding silent pipes under `max_blocking_threads(8)`), reader futures were
//! queued indefinitely behind the blocking tasks. Shell commands like `echo`
//! finished while their pipe readers were starved, leading to empty output
//! chunks or timeouts.
//!
//! This suite proves that Windows pipe readers use readiness polling and direct
//! synchronous reads of available bytes, completely bypassing Tokio's blocking
//! pool so that output is observed without loss even under 100% blocking-thread
//! pool saturation.
//!
//! What this suite does not catch: IOCP completion ports or non-pipe redirected
//! files.

use std::{
	io::{Read as _, Write as _},
	time::Duration,
};

use tokio_util::sync::CancellationToken;

use super::{
	ShellExecuteOptions, execute_shell, pipe_to_files, read_output, read_output_buffered,
	read_output_bytes, read_output_pipe_chunk_windows,
};
use crate::cancel::CancelToken;

#[test]
fn cancelled_output_reader_does_not_follow_new_background_bytes() {
	let rt = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.expect("runtime should build");
	rt.block_on(async {
		let (mut reader, mut writer) = pipe_to_files("cancel-drain").expect("pipe should open");
		writer
			.write_all(b"before")
			.expect("initial write should succeed");
		let cancel = CancellationToken::new();
		cancel.cancel();
		let mut buf = [0u8; 32];
		let mut drain_remaining = None;
		let mut poll_count = 0;
		let n = read_output_pipe_chunk_windows(
			&mut reader,
			&mut buf,
			&cancel,
			&mut poll_count,
			&mut drain_remaining,
		)
		.await
		.expect("pending bytes should drain")
		.expect("initial output should remain available");
		assert_eq!(&buf[..n], b"before");
		writer
			.write_all(b"after")
			.expect("background write should succeed");
		assert_eq!(
			read_output_pipe_chunk_windows(
				&mut reader,
				&mut buf,
				&cancel,
				&mut poll_count,
				&mut drain_remaining
			)
			.await
			.expect("drain should stop cleanly"),
			None,
			"cancelled output must not follow later background writes"
		);
	});
}

/// Helper that creates a multi-thread Tokio runtime with exactly 8 blocking
/// threads, spawns 8 blocking workers that hold open silent pipes to saturate
/// all 8 blocking threads, and returns the runtime, the unblock trigger
/// (writers), and task handles for clean joining.
fn setup_starvation_runtime()
-> (tokio::runtime::Runtime, Vec<std::fs::File>, Vec<tokio::task::JoinHandle<()>>) {
	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.max_blocking_threads(8)
		.enable_all()
		.build()
		.expect("runtime should build");

	let (starve_writers, starve_handles) = rt.block_on(async {
		let (starve_readers, starve_writers): (Vec<_>, Vec<_>) = (0..8)
			.map(|_| pipe_to_files("starve").expect("starvation pipe should be created"))
			.unzip();

		let mut starve_handles = Vec::with_capacity(8);
		for mut reader in starve_readers {
			starve_handles.push(tokio::task::spawn_blocking(move || {
				let mut byte = [0u8; 1];
				// Blocks until the corresponding starve_writer is dropped or closed.
				let _ = reader.read(&mut byte);
			}));
		}

		// Allow all 8 blocking tasks to enter their blocking read.
		tokio::time::sleep(Duration::from_millis(50)).await;

		(starve_writers, starve_handles)
	});

	(rt, starve_writers, starve_handles)
}

fn teardown_starvation(
	rt: tokio::runtime::Runtime,
	starve_writers: Vec<std::fs::File>,
	starve_handles: Vec<tokio::task::JoinHandle<()>>,
) {
	rt.block_on(async {
		// Drop all writers to unblock the 8 silent pipe reads.
		drop(starve_writers);
		for handle in starve_handles {
			let _ = handle.await;
		}
	});
}

#[test]
fn read_output_buffered_does_not_starve_when_blocking_pool_is_saturated() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();

	rt.block_on(async {
		let (reader, mut writer) =
			pipe_to_files("test-buffered").expect("test pipe should be created");
		let (chunk_tx, _chunk_rx) = flume::unbounded::<String>();
		let (activity_tx, _activity_rx) = flume::bounded(1);
		let cancel = CancellationToken::new();

		let reader_handle = tokio::spawn(read_output_buffered(
			reader,
			Some(chunk_tx),
			cancel,
			activity_tx,
			usize::MAX,
		));

		writer
			.write_all(b"buffered echo output\n")
			.expect("write should succeed");
		drop(writer);

		let output = tokio::time::timeout(Duration::from_secs(2), reader_handle)
			.await
			.expect("reader must not starve or time out under 8 busy blocking threads")
			.expect("reader task must join cleanly");

		assert_eq!(
			output.text, "buffered echo output\n",
			"reader must observe buffered text without starvation"
		);
	});

	teardown_starvation(rt, starve_writers, starve_handles);
}

#[test]
fn read_output_streaming_does_not_starve_when_blocking_pool_is_saturated() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();

	rt.block_on(async {
		let (reader, mut writer) =
			pipe_to_files("test-streaming").expect("test pipe should be created");
		let (chunk_tx, chunk_rx) = flume::unbounded::<String>();
		let (activity_tx, _activity_rx) = flume::bounded(1);
		let cancel = CancellationToken::new();

		let reader_handle = tokio::spawn(read_output(reader, Some(chunk_tx), cancel, activity_tx));

		writer
			.write_all(b"streaming echo output\n")
			.expect("write should succeed");
		drop(writer);

		tokio::time::timeout(Duration::from_secs(2), reader_handle)
			.await
			.expect("streaming reader must not starve or time out under 8 busy blocking threads")
			.expect("streaming reader task must join cleanly");

		let text = chunk_rx.drain().collect::<String>();
		assert_eq!(
			text, "streaming echo output\n",
			"streaming reader must observe text without starvation"
		);
	});

	teardown_starvation(rt, starve_writers, starve_handles);
}

#[test]
fn read_output_bytes_does_not_starve_when_blocking_pool_is_saturated() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();

	rt.block_on(async {
		let (reader, mut writer) = pipe_to_files("test-bytes").expect("test pipe should be created");
		let (byte_tx, byte_rx) = flume::unbounded();
		let (activity_tx, _activity_rx) = flume::bounded(1);
		let cancel = CancellationToken::new();

		let reader_handle =
			tokio::spawn(read_output_bytes(reader, Some(byte_tx), cancel, activity_tx));

		writer
			.write_all(b"raw byte output\n")
			.expect("write should succeed");
		drop(writer);

		tokio::time::timeout(Duration::from_secs(2), reader_handle)
			.await
			.expect("bytes reader must not starve or time out under 8 busy blocking threads")
			.expect("bytes reader task must join cleanly");

		let mut collected = Vec::new();
		while let Ok(chunk) = byte_rx.try_recv() {
			collected.extend_from_slice(&chunk);
		}
		assert_eq!(
			collected, b"raw byte output\n",
			"bytes reader must observe raw bytes without starvation"
		);
	});

	teardown_starvation(rt, starve_writers, starve_handles);
}

#[test]
fn execute_shell_echo_does_not_starve_when_blocking_pool_is_saturated() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();

	rt.block_on(async {
		let options = ShellExecuteOptions {
			command: "echo observable-echo-output".to_string(),
			..Default::default()
		};

		let (chunk_tx, chunk_rx) = flume::unbounded();

		let result = tokio::time::timeout(
			Duration::from_secs(4),
			execute_shell(options, Some(chunk_tx), CancelToken::default()),
		)
		.await
		.expect("execute_shell must not time out under 8 busy blocking threads")
		.expect("execute_shell must return Ok");

		let output = chunk_rx.drain().collect::<String>();
		assert!(
			output.contains("observable-echo-output"),
			"execute_shell must produce observable echo output, got: {output:?}"
		);
		assert_eq!(result.exit_code, Some(0), "echo should exit 0");
	});

	teardown_starvation(rt, starve_writers, starve_handles);
}

#[test]
fn twelve_parallel_shells_keep_stdout_and_stderr_with_a_saturated_blocking_pool() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();
	let outputs = rt.block_on(async {
		let mut calls = tokio::task::JoinSet::new();
		for index in 0..12 {
			calls.spawn(async move {
				let (chunk_tx, chunk_rx) = flume::unbounded();
				let result = execute_shell(
					ShellExecuteOptions {
						command: format!("echo stdout-{index}; echo stderr-{index} >&2"),
						timeout_ms: Some(4_000),
						..Default::default()
					},
					Some(chunk_tx),
					CancelToken::default(),
				)
				.await
				.expect("parallel shell must execute");
				(index, result, chunk_rx.drain().collect::<String>())
			});
		}
		let mut outputs = Vec::with_capacity(12);
		while let Some(result) = calls.join_next().await {
			outputs.push(result.expect("parallel shell task must finish"));
		}
		outputs
	});
	// Release the deliberately blocked workers before any assertion can panic.
	teardown_starvation(rt, starve_writers, starve_handles);

	assert_eq!(outputs.len(), 12, "every parallel command must finish");
	for (index, result, output) in outputs {
		assert_eq!(result.exit_code, Some(0), "command {index} must exit zero");
		assert!(!result.timed_out, "command {index} must not time out");
		assert!(!result.cancelled, "command {index} must not be cancelled");
		let mut lines: Vec<_> = output.lines().collect();
		lines.sort_unstable();
		assert_eq!(
			lines,
			vec![format!("stderr-{index}"), format!("stdout-{index}")],
			"command {index} must retain both streams"
		);
	}
}

#[test]
fn ready_pipe_honors_an_already_cancelled_token() {
	use std::io::Write as _;
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	let (mut reader, mut writer) = super::pipe_to_files("ready-cancel").unwrap();
	writer.write_all(b"x").unwrap();
	let cancel = tokio_util::sync::CancellationToken::new();
	cancel.cancel();
	let mut buffer = [0u8; 1];
	let mut polls = 0;
	let result = runtime
		.block_on(super::read_pipe_chunk_windows(&mut reader, &mut buffer, &cancel, &mut polls))
		.unwrap();
	assert_eq!(result, None, "ready bytes must not bypass cancellation");
}

#[test]
fn continuously_ready_pipe_yields_to_other_tasks() {
	use std::io::Write as _;
	let runtime = tokio::runtime::Builder::new_current_thread()
		.enable_all()
		.build()
		.unwrap();
	let (mut reader, mut writer) = super::pipe_to_files("ready-fairness").unwrap();
	let cancel = tokio_util::sync::CancellationToken::new();
	runtime.block_on(async {
		let task_cancel = cancel.clone();
		let cancelling_task = tokio::spawn(async move {
			task_cancel.cancel();
		});
		let mut buffer = [0u8; 1];
		let mut polls = 0;
		let mut observed_cancel = false;
		for _ in 0..100 {
			writer.write_all(b"x").unwrap();
			if super::read_pipe_chunk_windows(&mut reader, &mut buffer, &cancel, &mut polls)
				.await
				.unwrap()
				.is_none()
			{
				observed_cancel = true;
				break;
			}
		}
		cancelling_task.await.unwrap();
		assert!(observed_cancel, "continuously ready reads must yield to cancellation tasks");
	});
}
