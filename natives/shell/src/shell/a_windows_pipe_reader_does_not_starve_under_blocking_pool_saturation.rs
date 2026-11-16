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

#[test]
fn command_substitution_does_not_starve_when_blocking_pool_is_saturated() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();
	let (result, output) = rt.block_on(async {
		let options = ShellExecuteOptions {
			command: "echo sub=$(echo observable-sub-output)".to_string(),
			..Default::default()
		};
		let (chunk_tx, chunk_rx) = flume::unbounded();

		let result = tokio::time::timeout(
			Duration::from_secs(3),
			execute_shell(options, Some(chunk_tx), CancelToken::default()),
		)
		.await;

		let output = chunk_rx.drain().collect::<String>();
		(result, output)
	});

	teardown_starvation(rt, starve_writers, starve_handles);

	assert!(
		result.is_ok(),
		"command substitution must not starve under saturated blocking pool"
	);
	let result = result.unwrap().expect("execute_shell must succeed");
	assert_eq!(result.exit_code, Some(0));
	assert!(
		output.contains("sub=observable-sub-output"),
		"expected substitution output, got: {output:?}"
	);
}

#[test]
fn concurrent_coreutils_pipelines_do_not_deadlock_blocking_pool() {
	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(4)
		.max_blocking_threads(8)
		.enable_all()
		.build()
		.expect("runtime should build");

	let results = rt.block_on(async {
		let mut set = tokio::task::JoinSet::new();
		for idx in 0..8 {
			set.spawn(async move {
				let (chunk_tx, chunk_rx) = flume::unbounded();
				let res = execute_shell(
					ShellExecuteOptions {
						command: format!("echo pipe-{idx} | cat"),
						timeout_ms: Some(3_000),
						..Default::default()
					},
					Some(chunk_tx),
					CancelToken::default(),
				)
				.await
				.expect("pipeline must return");
				(idx, res, chunk_rx.drain().collect::<String>())
			});
		}
		let mut out = Vec::with_capacity(8);
		let all_done = tokio::time::timeout(Duration::from_secs(4), async {
			while let Some(item) = set.join_next().await {
				out.push(item.expect("task must not panic"));
			}
		})
		.await;
		(all_done.is_ok(), out)
	});

	let (all_done, results) = results;
	rt.shutdown_timeout(Duration::from_millis(100));
	assert!(all_done, "concurrent coreutils pipelines deadlocked blocking pool");
	assert_eq!(results.len(), 8);
	for (idx, res, text) in results {
		assert_eq!(res.exit_code, Some(0), "pipeline {idx} must exit 0");
		assert!(!res.timed_out, "pipeline {idx} must not time out");
		assert!(text.contains(&format!("pipe-{idx}")), "pipeline {idx} output: {text:?}");
	}
}

#[test]
fn pipeline_does_not_starve_when_blocking_pool_is_saturated() {
	let (rt, starve_writers, starve_handles) = setup_starvation_runtime();

	let (result, output) = rt.block_on(async {
		let options = ShellExecuteOptions {
			command: "echo pipe-start | cat".to_string(),
			timeout_ms: Some(3_000),
			..Default::default()
		};
		let (chunk_tx, chunk_rx) = flume::unbounded();
		let result = tokio::time::timeout(
			Duration::from_secs(3),
			execute_shell(options, Some(chunk_tx), CancelToken::default()),
		)
		.await;
		let output = chunk_rx.drain().collect::<String>();
		(result, output)
	});

	teardown_starvation(rt, starve_writers, starve_handles);

	let result = result
		.expect("pipeline must not starve under saturated blocking pool")
		.expect("execute_shell must succeed");
	assert_eq!(result.exit_code, Some(0));
	assert!(output.contains("pipe-start"), "expected pipeline output, got: {output:?}");
}

#[test]
fn blocked_windows_path_init_does_not_starve_other_shells_or_cancel() {
	use std::sync::{Arc, Condvar, Mutex};

	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(4)
		.max_blocking_threads(8)
		.enable_all()
		.build()
		.expect("runtime should build");

	let state = Arc::new((Mutex::new((0usize, false)), Condvar::new()));
	let hook_state = Arc::clone(&state);
	let hook_key = "blocked-init-repro";
	let _guard = crate::windows::test_hooks::install(
		hook_key,
		Arc::new(move || {
			let (lock, cvar) = &*hook_state;
			let mut guard = lock.lock().expect("hook state lock");
			guard.0 += 1;
			cvar.notify_all();
			while !guard.1 {
				guard = cvar.wait(guard).expect("hook wait");
			}
		}),
	);

	let mut abort_tokens = Vec::new();
	let mut blocked_rxs = Vec::new();
	for _ in 0..4 {
		let mut session_env = std::collections::HashMap::new();
		session_env.insert("VEYYON_TEST_BLOCK_WIN_INIT".to_string(), hook_key.to_string());
		let mut ct = CancelToken::default();
		abort_tokens.push(ct.emplace_abort_token());
		let (done_tx, done_rx) = std::sync::mpsc::channel();
		blocked_rxs.push(done_rx);
		rt.spawn(async move {
			let res = execute_shell(
				ShellExecuteOptions {
					command: "echo blocked".to_string(),
					session_env: Some(session_env),
					..Default::default()
				},
				None,
				ct,
			)
			.await;
			let _ = done_tx.send(res);
		});
	}

	// Wait outside Tokio so frozen Tokio workers cannot hang the test driver.
	let entered = {
		let (lock, cvar) = &*state;
		let mut guard = lock.lock().expect("lock");
		let deadline = std::time::Instant::now() + Duration::from_secs(3);
		while guard.0 < 4 {
			let rem = deadline.saturating_duration_since(std::time::Instant::now());
			if rem.is_zero() {
				break;
			}
			let (next, _) = cvar.wait_timeout(guard, rem).expect("wait_timeout");
			guard = next;
		}
		guard.0 == 4
	};

	let echo_res = if entered {
		let (echo_tx, echo_rx) = std::sync::mpsc::channel();
		rt.spawn(async move {
			let (chunk_tx, chunk_rx) = flume::unbounded();
			let res = execute_shell(
				ShellExecuteOptions {
					command: "echo responsive-under-blocked-init".to_string(),
					..Default::default()
				},
				Some(chunk_tx),
				CancelToken::default(),
			)
			.await;
			let _ = echo_tx.send((res, chunk_rx.drain().collect::<String>()));
		});
		echo_rx.recv_timeout(Duration::from_secs(2)).ok()
	} else {
		None
	};

	abort_tokens[0].abort(crate::cancel::AbortReason::Signal);
	let cancel_res = blocked_rxs[0].recv_timeout(Duration::from_secs(2)).ok();

	// Always unblock the init hooks before asserting so threads exit cleanly.
	{
		let (lock, cvar) = &*state;
		let mut guard = lock.lock().expect("release lock");
		guard.1 = true;
		cvar.notify_all();
	}
	for rx in blocked_rxs.into_iter().skip(1) {
		let _ = rx.recv_timeout(Duration::from_secs(2));
	}
	rt.shutdown_timeout(Duration::from_millis(100));

	assert!(entered, "4 calls must enter Windows path init");
	let (echo_ok, echo_output) =
		echo_res.expect("new echo shell must not starve while other shells block in Windows init");
	let echo_ok = echo_ok.expect("echo shell must succeed");
	assert_eq!(echo_ok.exit_code, Some(0));
	assert!(echo_output.contains("responsive-under-blocked-init"), "echo output: {echo_output:?}");

	let cancelled = cancel_res
		.expect("cancelling a blocked-init shell must return promptly")
		.expect("cancelled shell must return result");
	assert!(cancelled.cancelled, "expected cancelled=true, got: {cancelled:?}");
}

#[test]
fn cancelled_coreutils_reading_open_pipe_exits_promptly() {
	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.max_blocking_threads(8)
		.enable_all()
		.build()
		.expect("runtime should build");

	rt.block_on(async {
		let config = super::ShellConfig { session_env: None, snapshot_path: None, minimizer: None };
		let mut session = super::create_session(&config).await.expect("create session");
		let (pipe_reader, pipe_writer) = pipe_to_files("cat-stdin").expect("pipe");
		let cancel = CancellationToken::new();
		let mut params = session.shell.default_exec_params();
		params.set_fd(
			brush_core::openfiles::OpenFiles::STDIN_FD,
			brush_core::openfiles::OpenFile::from(pipe_reader),
		);
		params.set_fd(
			brush_core::openfiles::OpenFiles::STDOUT_FD,
			super::null_file().expect("null stdout"),
		);
		params.set_fd(
			brush_core::openfiles::OpenFiles::STDERR_FD,
			super::null_file().expect("null stderr"),
		);
		params.set_cancel_token(cancel.clone());

		let run_cancel = cancel.clone();
		let canceller = tokio::spawn(async move {
			tokio::time::sleep(Duration::from_millis(50)).await;
			run_cancel.cancel();
		});

		let source_info = brush_core::SourceInfo::from("test-cat-cancel");
		let run_res = tokio::time::timeout(
			Duration::from_secs(1),
			session.shell.run_string("cat".to_string(), &source_info, &params),
		)
		.await;

		drop(pipe_writer);
		let _ = canceller.await;
		let exec = run_res
			.expect("cancelled cat reading open pipe must exit promptly")
			.expect("run_string must return");
		assert_ne!(super::exit_code(&exec), 0, "cancelled cat should not exit 0");
	});
}

#[test]
fn read_output_bytes_with_stalled_sink_honors_cancellation() {
	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(2)
		.enable_all()
		.build()
		.expect("runtime should build");

	let (reader, mut writer) = pipe_to_files("stalled-bytes-sink").expect("pipe");
	let finished = rt.block_on(async {
		writer.write_all(b"pending-bytes\n").expect("write");
		let (byte_tx, _byte_rx) = flume::bounded(0);
		let (activity_tx, _activity_rx) = flume::bounded(1);
		let cancel = CancellationToken::new();

		let handle =
			tokio::spawn(read_output_bytes(reader, Some(byte_tx), cancel.clone(), activity_tx));
		tokio::time::sleep(Duration::from_millis(30)).await;
		cancel.cancel();

		tokio::time::timeout(Duration::from_secs(1), handle)
			.await
			.is_ok()
	});

	drop(writer);
	rt.shutdown_timeout(Duration::from_millis(50));
	assert!(
		finished,
		"read_output_bytes must stop promptly when cancelled even with full sink"
	);
}

#[test]
fn shell_session_echo_and_cancel_stay_responsive_under_saturated_pool_and_blocked_init() {
	use std::sync::{Arc, Condvar, Mutex};

	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(4)
		.max_blocking_threads(8)
		.enable_all()
		.build()
		.expect("runtime should build");

	// Saturate all 8 blocking threads with open silent pipes.
	let (starve_writers, starve_handles) = rt.block_on(async {
		let (starve_readers, starve_writers): (Vec<_>, Vec<_>) = (0..8)
			.map(|_| pipe_to_files("combined-starve").expect("starvation pipe"))
			.unzip();
		let mut handles = Vec::with_capacity(8);
		for mut reader in starve_readers {
			handles.push(tokio::task::spawn_blocking(move || {
				let mut byte = [0u8; 1];
				let _ = reader.read(&mut byte);
			}));
		}
		tokio::time::sleep(Duration::from_millis(50)).await;
		(starve_writers, handles)
	});

	let state = Arc::new((Mutex::new((0usize, false)), Condvar::new()));
	let hook_state = Arc::clone(&state);
	let hook_key = "combined-blocked-init";
	let _guard = crate::windows::test_hooks::install(
		hook_key,
		Arc::new(move || {
			let (lock, cvar) = &*hook_state;
			let mut guard = lock.lock().expect("hook state lock");
			guard.0 += 1;
			cvar.notify_all();
			while !guard.1 {
				guard = cvar.wait(guard).expect("hook wait");
			}
		}),
	);

	let mut blocked_shells = Vec::new();
	let mut blocked_rxs = Vec::new();
	for _ in 0..4 {
		let mut session_env = std::collections::HashMap::new();
		session_env.insert("VEYYON_TEST_BLOCK_WIN_INIT".to_string(), hook_key.to_string());
		let shell = Arc::new(super::Shell::new(Some(super::ShellOptions {
			session_env: Some(session_env),
			..Default::default()
		})));
		blocked_shells.push(Arc::clone(&shell));
		let (done_tx, done_rx) = std::sync::mpsc::channel();
		blocked_rxs.push(done_rx);
		rt.spawn(async move {
			let res = shell
				.run(
					super::ShellRunOptions {
						command: "echo blocked".to_string(),
						..Default::default()
					},
					None,
					CancelToken::default(),
				)
				.await;
			let _ = done_tx.send(res);
		});
	}

	let entered = {
		let (lock, cvar) = &*state;
		let mut guard = lock.lock().expect("lock");
		let deadline = std::time::Instant::now() + Duration::from_secs(3);
		while guard.0 < 4 {
			let rem = deadline.saturating_duration_since(std::time::Instant::now());
			if rem.is_zero() {
				break;
			}
			let (next, _) = cvar.wait_timeout(guard, rem).expect("wait_timeout");
			guard = next;
		}
		guard.0 == 4
	};

	let new_shell_echo = if entered {
		let (tx, rx) = std::sync::mpsc::channel();
		rt.spawn(async move {
			let shell = super::Shell::new(None);
			let (chunk_tx, chunk_rx) = flume::unbounded();
			let res = shell
				.run(
					super::ShellRunOptions {
						command: "echo new-shell-ok; echo sub=$(echo nested-ok)".to_string(),
						..Default::default()
					},
					Some(chunk_tx),
					CancelToken::default(),
				)
				.await;
			let _ = tx.send((res, chunk_rx.drain().collect::<String>()));
		});
		rx.recv_timeout(Duration::from_secs(2)).ok()
	} else {
		None
	};

	// Cancel one of the blocked-init Shell sessions via Shell::abort() while
	// both the blocking pool is saturated and the other 3 init threads remain blocked.
	let abort_target = Arc::clone(&blocked_shells[0]);
	rt.spawn(async move {
		abort_target.abort().await;
	});
	let abort_res = blocked_rxs[0].recv_timeout(Duration::from_secs(2)).ok();

	// Unblock init hooks and release saturated blocking pipes before asserting.
	{
		let (lock, cvar) = &*state;
		let mut guard = lock.lock().expect("release lock");
		guard.1 = true;
		cvar.notify_all();
	}
	for rx in blocked_rxs.into_iter().skip(1) {
		let _ = rx.recv_timeout(Duration::from_secs(2));
	}
	teardown_starvation(rt, starve_writers, starve_handles);

	assert!(entered, "4 Shell::run calls must enter Windows init");
	let (echo_res, echo_out) =
		new_shell_echo.expect("new Shell echo must succeed under saturated pool + blocked init");
	let echo_res = echo_res.expect("new Shell run must return Ok");
	assert_eq!(echo_res.exit_code, Some(0));
	assert!(echo_out.contains("new-shell-ok"), "echo output: {echo_out:?}");
	assert!(echo_out.contains("sub=nested-ok"), "sub output: {echo_out:?}");

	let aborted = abort_res
		.expect("Shell::abort on blocked-init session must return promptly")
		.expect("aborted Shell::run must return Ok");
	assert!(aborted.cancelled, "expected cancelled=true, got: {aborted:?}");
}

#[test]
fn deeply_nested_command_substitutions_above_32_do_not_deadlock() {
	let rt = tokio::runtime::Builder::new_multi_thread()
		.worker_threads(4)
		.max_blocking_threads(8)
		.enable_all()
		.build()
		.expect("runtime should build");

	let mut cmd = "echo deep-ok".to_string();
	for _ in 0..40 {
		cmd = format!("echo $({cmd})");
	}

	let (res, output) = rt.block_on(async {
		let (chunk_tx, chunk_rx) = flume::unbounded();
		let res = tokio::time::timeout(
			Duration::from_secs(5),
			execute_shell(
				ShellExecuteOptions {
					command: cmd,
					timeout_ms: Some(4_000),
					..Default::default()
				},
				Some(chunk_tx),
				CancelToken::default(),
			),
		)
		.await
		.expect("40-level nested command substitution must not deadlock")
		.expect("execute_shell must return Ok");
		(res, chunk_rx.drain().collect::<String>())
	});
	rt.shutdown_timeout(Duration::from_millis(100));
	assert_eq!(res.exit_code, Some(0));
	assert!(!res.timed_out);
	assert!(output.contains("deep-ok"), "output: {output:?}");
}
