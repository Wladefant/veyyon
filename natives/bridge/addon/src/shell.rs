//! Brush-based shell execution exported via N-API.

use std::{
	collections::HashMap,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use napi::{
	Env, Result,
	bindgen_prelude::*,
	threadsafe_function::{ThreadsafeFunction, UnknownReturnValue},
};
use napi_derive::napi;
use veyyon_shell::{
	MinimizerResult as CoreMinimizerResult, Shell as CoreShell,
	ShellExecuteOptions as CoreShellExecuteOptions, ShellOptions as CoreShellOptions,
	ShellRunOptions as CoreShellRunOptions, ShellRunResult as CoreShellRunResult,
	cancel::{
		AbortReason as CoreAbortReason, AbortToken as CoreAbortToken,
		CancelToken as CoreCancelToken,
	},
	execute_shell as core_execute_shell, minimizer,
};

use crate::{napi_error::to_napi, task};

/// N-API opt-in handle for the minimizer.
#[napi(object)]
#[derive(Debug, Clone, Default)]
pub struct MinimizerOptions {
	/// Master switch. Absent / false = disabled.
	pub enabled:              Option<bool>,
	/// Optional path to a TOML settings file whose values override
	/// field-level defaults. `~` is expanded.
	pub settings_path:        Option<String>,
	/// Optional xxHash64 digest (hex) of the settings file contents. When
	/// supplied, the engine refuses to honor a settings file whose hash does
	/// not match — a lightweight trust gate for agent-controllable paths.
	pub settings_hash:        Option<String>,
	/// Opt-in allowlist of program names (e.g. `"git"`). When empty or
	/// absent, all built-in filters are active.
	pub only:                 Option<Vec<String>>,
	/// Program names explicitly excluded from minimization.
	pub except:               Option<Vec<String>>,
	/// Maximum captured bytes per command before the engine falls back to
	/// the raw, un-minimized output. Default 4 MiB.
	pub max_capture_bytes:    Option<u32>,
	/// Source-outline level for `cat <source-file>` minimization. Accepts
	/// `"default"` (current behavior) or `"aggressive"` (strip function bodies).
	pub source_outline_level: Option<String>,
	/// Kill-switch to fall back to the pre-PR (legacy) filter behavior for
	/// grep / find / pytest. When `Some(true)`, filters that opted into the
	/// always-shrink Tier 1 / Tier 2 behavior skip the new code path. When
	/// `None`, defers to the `VEYYON_MINIMIZER_LEGACY_FILTERS` env var.
	pub legacy_filters:       Option<bool>,
}

impl From<MinimizerOptions> for minimizer::MinimizerOptions {
	fn from(value: MinimizerOptions) -> Self {
		Self {
			enabled:              value.enabled,
			settings_path:        value.settings_path,
			settings_hash:        value.settings_hash,
			only:                 value.only,
			except:               value.except,
			max_capture_bytes:    value.max_capture_bytes,
			source_outline_level: value.source_outline_level,
			legacy_filters:       value.legacy_filters,
		}
	}
}

/// Options for configuring a persistent shell session.
#[napi(object)]
pub struct ShellOptions {
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
}

impl From<ShellOptions> for CoreShellOptions {
	fn from(value: ShellOptions) -> Self {
		Self {
			session_env:   value.session_env,
			snapshot_path: value.snapshot_path,
			minimizer:     value.minimizer.map(Into::into),
		}
	}
}

/// Options for running a shell command.
#[napi(object)]
pub struct ShellRunOptions<'env> {
	/// Command string to execute in the shell.
	pub command:       String,
	/// Working directory for the command.
	pub cwd:           Option<String>,
	/// Environment variables to apply for this command only.
	pub env:           Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:    Option<u32>,
	/// Abort signal for cancelling the operation.
	pub signal:        Option<Unknown<'env>>,
	/// Session CPU cgroup directory (cgroups v2, Linux): every external child
	/// this run spawns is adopted into it, so the kernel quota in its
	/// `cpu.max` bounds the whole command tree. Unset means uncapped.
	pub cpu_budget_id: Option<String>,
}

/// Options for executing a shell command via brush-core.
#[napi(object)]
pub struct ShellExecuteOptions<'env> {
	/// Command string to execute in the shell.
	pub command:       String,
	/// Working directory for the command.
	pub cwd:           Option<String>,
	/// Environment variables to apply for this command only.
	pub env:           Option<HashMap<String, String>>,
	/// Environment variables to apply once per session.
	pub session_env:   Option<HashMap<String, String>>,
	/// Timeout in milliseconds before cancelling the command.
	pub timeout_ms:    Option<u32>,
	/// Optional snapshot file to source on session creation.
	pub snapshot_path: Option<String>,
	/// Optional per-command output minimizer configuration.
	pub minimizer:     Option<MinimizerOptions>,
	/// Abort signal for cancelling the operation.
	pub signal:        Option<Unknown<'env>>,
	/// Session CPU cgroup directory (cgroups v2, Linux): every external child
	/// this run spawns is adopted into it. Unset means uncapped.
	pub cpu_budget_id: Option<String>,
}

/// Telemetry for a single minimization.
///
/// Surfaced when the minimizer actually rewrote the command's output. The
/// session layer is expected to persist `original_text` via its
/// `ArtifactManager`, splice the resulting `artifact://<id>` reference
/// into `text`, and replace any previously streamed raw output with the
/// minimized text.
#[napi(object)]
pub struct MinimizerResult {
	/// Dispatch label produced by the minimizer (e.g. `"git"`,
	/// `"pipeline:gradle"`, `"pipeline+builtin"`).
	pub filter:        String,
	/// The minimized replacement text. Callers that streamed raw chunks
	/// during execution should clear and replace their accumulated output
	/// with this text.
	pub text:          String,
	/// The full original capture, before minimization.
	pub original_text: String,
	/// Captured byte length before minimization.
	pub input_bytes:   u32,
	/// Byte length of the minimized text the consumer received.
	pub output_bytes:  u32,
}

impl From<CoreMinimizerResult> for MinimizerResult {
	fn from(value: CoreMinimizerResult) -> Self {
		Self {
			filter:        value.filter,
			text:          value.text,
			original_text: value.original_text,
			input_bytes:   value.input_bytes,
			output_bytes:  value.output_bytes,
		}
	}
}

/// Result of running a shell command.
#[napi(object)]
pub struct ShellRunResult {
	/// Exit code when the command completes normally.
	pub exit_code:         Option<i32>,
	/// The signal number that killed the command, when it died from a signal.
	///
	/// `exitCode` reports bash's `128 + signal`, which a command that calls
	/// `exit(137)` itself produces just as readily. This field is set only for a
	/// real signalled death, so callers can tell an out-of-memory kill (SIGKILL,
	/// 9) from a program choosing that exit code.
	pub signal:            Option<i32>,
	/// Whether the command was cancelled via abort.
	pub cancelled:         bool,
	/// Whether the command timed out before completion.
	pub timed_out:         bool,
	/// Whether output capture stopped before EOF.
	pub output_incomplete: bool,
	/// Retained raw output prefix, present only for incomplete buffered capture.
	pub captured_output:   Option<String>,
	/// When the minimizer rewrote the captured output, this carries the
	/// original buffer + telemetry so the session layer can persist it as
	/// an artifact and splice an `artifact://<id>` reference into the
	/// minimized text shown to the agent. `None` when nothing was rewritten.
	pub minimized:         Option<MinimizerResult>,
	/// Shell working directory after command completion.
	pub working_dir:       Option<String>,
}
impl From<CoreShellRunResult> for ShellRunResult {
	fn from(value: CoreShellRunResult) -> Self {
		Self {
			exit_code:         value.exit_code,
			signal:            value.signal,
			cancelled:         value.cancelled,
			timed_out:         value.timed_out,
			output_incomplete: value.output_incomplete,
			captured_output:   value.captured_output,
			minimized:         value.minimized.map(Into::into),
			working_dir:       value.working_dir,
		}
	}
}

/// Maximum idle time without chunk-forwarder progress after core shell
/// execution completes. Healthy slow callbacks refresh this window whenever
/// a batch settles, so total stream duration is unbounded while genuine stalls
/// abort, reap, and surface an explicit transport error.
const POST_COMPLETION_DRAIN_IDLE_GRACE: Duration = Duration::from_secs(1);

#[derive(Default)]
struct ActiveRunRegistry {
	runs:    parking_lot::Mutex<HashMap<u64, CoreAbortToken>>,
	next_id: AtomicU64,
}

impl ActiveRunRegistry {
	fn register(self: &Arc<Self>, cancel_token: &mut CoreCancelToken) -> ActiveRunGuard {
		let abort_token = cancel_token.emplace_abort_token();
		let id = self.next_id.fetch_add(1, Ordering::Relaxed);
		self.runs.lock().insert(id, abort_token);
		ActiveRunGuard { registry: Arc::clone(self), id }
	}

	fn abort_all(&self, reason: CoreAbortReason) {
		let tokens: Vec<CoreAbortToken> = self.runs.lock().values().cloned().collect();
		for token in tokens {
			token.abort(reason);
		}
	}

	#[cfg(test)]
	fn active_count(&self) -> usize {
		self.runs.lock().len()
	}
}

struct ActiveRunGuard {
	registry: Arc<ActiveRunRegistry>,
	id:       u64,
}

impl Drop for ActiveRunGuard {
	fn drop(&mut self) {
		self.registry.runs.lock().remove(&self.id);
	}
}

/// Persistent brush-core shell session.
#[napi]
pub struct Shell {
	inner:       Arc<CoreShell>,
	active_runs: Arc<ActiveRunRegistry>,
}

impl Shell {
	async fn run_with_bridge(
		inner: Arc<CoreShell>,
		run_guard: ActiveRunGuard,
		run_options: CoreShellRunOptions,
		core_cancel: CoreCancelToken,
		chunk_tx: Option<flume::Sender<String>>,
		drain: Option<ChunkDrain>,
	) -> Result<ShellRunResult> {
		let _run_guard = run_guard;
		let result = inner
			.run(run_options, chunk_tx, core_cancel.clone())
			.await
			.map(Into::into)
			.map_err(to_napi);
		await_chunk_drain(drain, &core_cancel, result).await
	}
}

#[napi]
impl Shell {
	/// Create a new shell session from optional configuration.
	///
	/// The options set session-scoped environment variables and a snapshot path.
	#[napi(constructor)]
	pub fn new(options: Option<ShellOptions>) -> Self {
		Self {
			inner:       Arc::new(CoreShell::new(options.map(Into::into))),
			active_runs: Arc::new(ActiveRunRegistry::default()),
		}
	}

	/// Run a shell command using the provided options.
	///
	/// The `on_chunk` callback receives streamed stdout/stderr output. Returns
	/// the exit code when the command completes, or flags when cancelled or
	/// timed out.
	#[napi]
	pub fn run<'env>(
		&self,
		env: &'env Env,
		options: ShellRunOptions<'env>,
		#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
		on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
	) -> Result<PromiseRaw<'env, ShellRunResult>> {
		let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
		let mut core_cancel = cancel_token.into_core();
		let run_guard = self.active_runs.register(&mut core_cancel);
		let inner = Arc::clone(&self.inner);
		let run_options = CoreShellRunOptions {
			command:       options.command,
			cwd:           options.cwd,
			env:           options.env,
			timeout_ms:    options.timeout_ms,
			cpu_budget_id: options.cpu_budget_id,
		};
		task::future(env, "shell.run", async move {
			let (chunk_tx, drain) = bridge_chunks(on_chunk);
			Self::run_with_bridge(inner, run_guard, run_options, core_cancel, chunk_tx, drain).await
		})
	}

	/// Abort all running commands for this shell session.
	///
	/// Returns `Ok(())` even when no commands are running.
	#[napi]
	pub async fn abort(&self) -> Result<()> {
		self.active_runs.abort_all(CoreAbortReason::Signal);
		self.inner.abort().await;
		Ok(())
	}

	/// Count live background jobs (`&`/`nohup` children still running) on this
	/// session. Completed jobs are reaped first. The host uses this to retain a
	/// per-call shell whose background processes are still running instead of
	/// dropping it (which would SIGKILL them via kill-on-drop).
	#[napi]
	pub async fn live_background_job_count(&self) -> u32 {
		self.inner.live_background_job_count().await
	}
}

/// Execute a brush shell command.
///
/// Creates a fresh session for each call. The `on_chunk` callback receives
/// streamed stdout/stderr output. Returns the exit code when the command
/// completes, or flags when cancelled or timed out.
#[napi]
pub fn execute_shell<'env>(
	env: &'env Env,
	options: ShellExecuteOptions<'env>,
	#[napi(ts_arg_type = "((error: Error | null, chunk: string) => void) | undefined | null")]
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> Result<PromiseRaw<'env, ShellRunResult>> {
	let cancel_token = task::CancelToken::new(options.timeout_ms, options.signal);
	let exec_options = CoreShellExecuteOptions {
		command:       options.command,
		cwd:           options.cwd,
		env:           options.env,
		session_env:   options.session_env,
		timeout_ms:    options.timeout_ms,
		snapshot_path: options.snapshot_path,
		minimizer:     options.minimizer.map(Into::into),
		cpu_budget_id: options.cpu_budget_id,
	};
	task::future(env, "shell.execute", async move {
		let core_cancel = cancel_token.into_core();
		let (chunk_tx, drain) = bridge_chunks(on_chunk);
		let result = core_execute_shell(exec_options, chunk_tx, core_cancel.clone())
			.await
			.map(Into::into)
			.map_err(to_napi);
		await_chunk_drain(drain, &core_cancel, result).await
	})
}

/// Capacity (in chunks) of the queue between the pipe readers and the JS
/// forwarding pump. One queued chunk is at most one pipe read (≤64 KiB), so
/// the Rust side of the bridge holds ~4 MiB worst case before the readers'
/// `send_async` parks — which in turn parks the child on its stdout/stderr
/// pipe (ordinary pipe backpressure) instead of buffering the surplus in
/// process memory (#4078).
const BRIDGE_QUEUE_CHUNKS: usize = 64;

struct ChunkDrain {
	handle:      napi::tokio::task::JoinHandle<()>,
	progress_rx: napi::tokio::sync::watch::Receiver<u64>,
}

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (Option<flume::Sender<String>>, Option<ChunkDrain>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
	let (progress_tx, progress_rx) = napi::tokio::sync::watch::channel(0u64);
	let handle = napi::tokio::spawn(pump_chunks_with_progress(
		rx,
		Some(progress_tx),
		async move |payload: String| {
			// `call_async` resolves only after the JS callback ran, so at most
			// one batch sits in the napi queue at a time and the JS event loop's
			// actual consumption rate backpressures the whole pipeline. An error
			// means the JS side is gone (env teardown) — stop forwarding.
			on_chunk.call_async(Ok(payload)).await.is_ok()
		},
	));
	(Some(tx), Some(ChunkDrain { handle, progress_rx }))
}

async fn await_chunk_drain(
	drain: Option<ChunkDrain>,
	cancel_token: &CoreCancelToken,
	result: Result<ShellRunResult>,
) -> Result<ShellRunResult> {
	let Some(ChunkDrain { mut handle, mut progress_rx }) = drain else {
		return result;
	};
	let idle_sleep = napi::tokio::time::sleep(POST_COMPLETION_DRAIN_IDLE_GRACE);
	napi::tokio::pin!(idle_sleep);
	let mut progress_open = true;
	loop {
		tokio::select! {
			biased;
			_ = &mut handle => return result,
			reason = cancel_token.wait() => {
				handle.abort();
				let _ = handle.await;
				return match result {
					Ok(res) if res.cancelled || res.timed_out => Ok(res),
					Ok(_) => Err(Error::from_reason(format!(
						"Shell output callback drain aborted ({reason:?})"
					))),
					Err(err) => Err(err),
				};
			}
			changed = progress_rx.changed(), if progress_open => {
				if changed.is_ok() {
					idle_sleep.as_mut().reset(
						napi::tokio::time::Instant::now() + POST_COMPLETION_DRAIN_IDLE_GRACE,
					);
				} else {
					progress_open = false;
				}
			}
			() = &mut idle_sleep => {
				handle.abort();
				let _ = handle.await;
				return match result {
					Ok(res) if res.cancelled || res.timed_out => Ok(res),
					Ok(_) => Err(Error::from_reason(
						"Shell output callback drain stalled after command completion"
					)),
					Err(err) => Err(err),
				};
			}
		}
	}
}

/// Drain `rx`, greedily coalescing queued chunks into ≤64 KiB batches, and
/// feed each batch to `forward`, awaiting its completion before pulling more.
/// Returns when `rx` disconnects (all senders dropped) or `forward` reports
/// the consumer is gone; dropping `rx` then disconnects the channel so
/// parked/future senders fail fast and the pipe readers keep draining the
/// child instead of wedging it.
async fn pump_chunks(rx: flume::Receiver<String>, forward: impl AsyncFnMut(String) -> bool) {
	pump_chunks_with_progress(rx, None, forward).await;
}

async fn pump_chunks_with_progress(
	rx: flume::Receiver<String>,
	progress_tx: Option<napi::tokio::sync::watch::Sender<u64>>,
	mut forward: impl AsyncFnMut(String) -> bool,
) {
	// Hard cap on one coalesced batch so the JS main thread never sees a
	// multi-MB napi callback (a giant single string would stall sanitize +
	// tail-buffer maintenance for the whole copy).
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	// Initial capacity sized for typical bursty pipe output. Re-allocated
	// each batch because `String` ownership is moved into the napi call.
	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	let mut seq = 0u64;
	while let Ok(first) = rx.recv_async().await {
		batch.push_str(&first);
		// Greedily drain everything already queued. Child processes that
		// write byte-at-a-time (printf-style progress, llama-cli token
		// streams) otherwise produce one napi callback per `write(2)`,
		// saturating the JS main thread (~200% CPU observed) and leaving
		// the queue draining long after the child exits.
		while batch.len() < MAX_BATCH_BYTES {
			match rx.try_recv() {
				Ok(more) => batch.push_str(&more),
				Err(_) => break,
			}
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		let keep_going = forward(payload).await;
		if let Some(tx) = &progress_tx {
			seq = seq.wrapping_add(1);
			let _ = tx.send(seq);
		}
		if !keep_going {
			return;
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use flume;
	use tokio::time;
	use veyyon_shell::{
		ShellRunOptions as CoreShellRunOptions,
		cancel::{AbortReason, CancelToken},
	};

	use super::{
		BRIDGE_QUEUE_CHUNKS, ChunkDrain, CoreShell, Shell, ShellRunResult, await_chunk_drain,
		pump_chunks, pump_chunks_with_progress,
	};

	fn spawn_test_drain<F, Fut>(rx: flume::Receiver<String>, forward: F) -> ChunkDrain
	where
		F: FnMut(String) -> Fut + Send + 'static,
		Fut: Future<Output = bool> + Send,
	{
		let (progress_tx, progress_rx) = tokio::sync::watch::channel(0u64);
		let handle = tokio::spawn(pump_chunks_with_progress(rx, Some(progress_tx), forward));
		ChunkDrain { handle, progress_rx }
	}

	/// Regression for #4078: the reader→JS bridge queue must stay bounded when
	/// the JS side (here: a deliberately slow `forward`) cannot keep up with a
	/// fast producer, and backpressure must never drop or reorder chunks. On
	/// the pre-fix bridge (`flume::unbounded` + fire-and-forget
	/// `ThreadsafeFunctionCallMode::NonBlocking`) the same harness accumulates
	/// the producer's entire surplus in the queue (measured: a 32 MiB stream
	/// queued all `33_554_432` bytes while the consumer stalled).
	#[tokio::test(flavor = "multi_thread")]
	async fn bridge_pump_bounds_queue_and_delivers_all_bytes() {
		const CHUNKS: usize = 512;
		const CHUNK_BYTES: usize = 4096;
		let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
		let producer = tokio::spawn(async move {
			let mut expected = String::with_capacity(CHUNKS * CHUNK_BYTES);
			let mut max_queued = 0usize;
			for i in 0..CHUNKS {
				let chunk = format!("[{i:06}]{}", "x".repeat(CHUNK_BYTES - 8));
				expected.push_str(&chunk);
				tx.send_async(chunk)
					.await
					.expect("pump should outlive the producer");
				max_queued = max_queued.max(tx.len());
			}
			(expected, max_queued)
		});

		let mut received = String::with_capacity(CHUNKS * CHUNK_BYTES);
		time::timeout(
			Duration::from_secs(30),
			pump_chunks(rx, async |payload: String| {
				received.push_str(&payload);
				// Emulate a busy JS event loop: each napi callback takes a while.
				time::sleep(Duration::from_micros(500)).await;
				true
			}),
		)
		.await
		.expect("pump should finish once the producer hangs up");

		let (expected, max_queued) = producer.await.expect("producer task");
		assert!(
			max_queued <= BRIDGE_QUEUE_CHUNKS,
			"bridge queue grew past its bound: {max_queued} chunks",
		);
		assert_eq!(received.len(), expected.len(), "bytes were dropped or duplicated");
		assert_eq!(received, expected, "chunks must arrive losslessly and in order");
	}

	/// When the JS side dies (`forward` fails: threadsafe function aborted on
	/// env teardown), the pump must drop its receiver so parked and future
	/// sends fail fast — the pipe readers keep draining the child instead of
	/// wedging it on a full bridge queue.
	#[tokio::test(flavor = "multi_thread")]
	async fn bridge_pump_death_disconnects_channel_without_blocking_senders() {
		let (tx, rx) = flume::bounded::<String>(4);
		let pump = tokio::spawn(pump_chunks(rx, async |_payload: String| false));
		let producer = tokio::spawn(async move {
			let mut disconnected = 0usize;
			for _ in 0..64 {
				if tx.send_async("x".repeat(1024)).await.is_err() {
					disconnected += 1;
				}
			}
			disconnected
		});
		let disconnected = time::timeout(Duration::from_secs(5), producer)
			.await
			.expect("sends must not park once the consumer died")
			.expect("producer task");
		assert!(disconnected > 0, "channel should disconnect after the pump stops");
		time::timeout(Duration::from_secs(5), pump)
			.await
			.expect("pump should exit after forward fails")
			.expect("pump task");
	}

	mod child_session_action_tests {
		use veyyon_shell::{ChildSessionAction, child_session_action};

		#[test]
		fn interactive_with_terminal_stdin_takes_foreground() {
			assert_eq!(child_session_action(true, true, false), ChildSessionAction::TakeForeground);
			assert_eq!(child_session_action(true, true, true), ChildSessionAction::TakeForeground);
		}

		#[test]
		fn non_terminal_stdin_detaches_regardless_of_pipeline() {
			assert_eq!(child_session_action(true, false, false), ChildSessionAction::DetachSession);
			// A leading-new-pgroup stage of a pipeline still detaches: setsid keeps
			// it off the host's controlling tty.
			assert_eq!(child_session_action(true, false, true), ChildSessionAction::DetachSession);
		}

		#[test]
		fn non_interactive_with_terminal_stdin_does_nothing() {
			assert_eq!(child_session_action(false, true, false), ChildSessionAction::None);
		}

		#[test]
		fn non_interactive_terminal_stdin_in_pipeline_does_nothing() {
			assert_eq!(child_session_action(false, true, true), ChildSessionAction::None);
		}

		#[test]
		fn embedded_host_with_non_terminal_stdin_detaches() {
			assert_eq!(child_session_action(false, false, false), ChildSessionAction::DetachSession);
		}

		#[test]
		fn pipeline_stage_with_non_terminal_stdin_detaches() {
			// Regression: an interactive child inside a pipeline (`zsh -i | awk`)
			// must not stay in the host session and seize its tty. Pre-fix this
			// returned `None`, leaving the stage attached and able to SIGTTIN the host.
			assert_eq!(child_session_action(false, false, true), ChildSessionAction::DetachSession);
		}
	}

	#[cfg(unix)]
	#[tokio::test(flavor = "multi_thread")]
	async fn embedded_external_command_runs_in_its_own_session() {
		let shell = CoreShell::new(None);
		let (tx, rx) = flume::unbounded::<String>();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:       "/bin/sh -c 'printf \"%d\\n\" \"$$\"; sleep 0.5'".to_string(),
						cwd:           None,
						env:           None,
						timeout_ms:    None,
						cpu_budget_id: None,
					},
					Some(tx),
					CancelToken::default(),
				)
				.await
		});
		let child_pid = time::timeout(Duration::from_secs(5), rx.recv_async())
			.await
			.expect("timed out waiting for child pid")
			.expect("missing child pid chunk")
			.trim()
			.parse::<i32>()
			.expect("child pid parses");
		// SAFETY: `getsid(0)` only queries the current process session; the
		// return value is checked below. Inside a PID namespace (e.g. the
		// containerized CI runner) the host's session leader can live outside
		// the namespace, so `getsid(0)` legitimately reports 0 — only -1 is a
		// real failure. The meaningful invariant is that the child detached
		// into its own session (`child_sid == child_pid`, distinct from host).
		let host_sid = unsafe { libc::getsid(0) };
		assert!(host_sid >= 0, "getsid(0) failed: {}", std::io::Error::last_os_error());
		// SAFETY: `child_pid` is a live positive PID reported by the child; the
		// return value is checked below.
		let child_sid = unsafe { libc::getsid(child_pid) };
		assert!(child_sid > 0, "getsid({child_pid}) failed: {}", std::io::Error::last_os_error());
		let result = handle
			.await
			.expect("shell task panicked")
			.expect("shell run");
		assert_eq!(result.exit_code, Some(0));
		assert_ne!(child_sid, host_sid);
		assert_eq!(child_sid, child_pid);
	}

	#[tokio::test]
	async fn read_output_stops_when_cancelled_before_pipe_eof() {
		let shell = CoreShell::new(None);
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let handle = tokio::spawn(async move {
			shell
				.run(
					CoreShellRunOptions {
						command:       "sh -c 'sleep 30 & wait'".to_string(),
						cwd:           None,
						env:           None,
						timeout_ms:    None,
						cpu_budget_id: None,
					},
					None,
					cancel,
				)
				.await
		});

		time::sleep(Duration::from_millis(10)).await;
		abort.abort(AbortReason::Signal);
		let result = time::timeout(Duration::from_secs(3), handle)
			.await
			.expect("shell run should stop after cancellation")
			.expect("shell task should not panic")
			.expect("shell run should return");
		assert!(result.cancelled);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_stalled_forward_settles_on_cancellation_and_releases_resources() {
		let shell = CoreShell::new(None);
		let mut cancel = CancelToken::default();
		let abort = cancel.emplace_abort_token();
		let (tx, rx) = flume::bounded::<String>(4);
		let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
		let started_tx = std::sync::Arc::new(parking_lot::Mutex::new(Some(started_tx)));
		let callback_resource = std::sync::Arc::new(());
		let drain = spawn_test_drain(rx, move |payload: String| {
			if payload.contains("READY")
				&& let Some(tx) = started_tx.lock().take()
			{
				let _ = tx.send(());
			}
			let _keep_alive = std::sync::Arc::clone(&callback_resource);
			async move { std::future::pending::<bool>().await }
		});

		let run_task = tokio::spawn(async move {
			let result = shell
				.run(
					CoreShellRunOptions {
						command:       "sh -c 'echo READY; sleep 30'".to_string(),
						cwd:           None,
						env:           None,
						timeout_ms:    None,
						cpu_budget_id: None,
					},
					Some(tx),
					cancel.clone(),
				)
				.await
				.map(Into::into)
				.map_err(crate::napi_error::to_napi);
			await_chunk_drain(Some(drain), &cancel, result).await
		});

		time::timeout(Duration::from_secs(15), started_rx)
			.await
			.expect("external child output should reach on_chunk before cancellation")
			.expect("forward started signal should not drop");
		abort.abort(AbortReason::Signal);

		let settled = time::timeout(Duration::from_secs(5), run_task)
			.await
			.expect("cancelled shell must settle even when on_chunk stalls")
			.expect("run task should not panic")
			.expect("cancelled shell should return ShellRunResult");
		assert!(settled.cancelled, "expected cancelled=true");
		assert!(
			callback_weak.upgrade().is_none(),
			"stalled pump task and callback resources must be released",
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_stalled_forward_after_success_returns_transport_error_on_deadline() {
		let (tx, rx) = flume::bounded::<String>(4);
		let callback_resource = std::sync::Arc::new(());
		let callback_weak = std::sync::Arc::downgrade(&callback_resource);
		let drain = spawn_test_drain(rx, move |_payload: String| {
			let _keep_alive = std::sync::Arc::clone(&callback_resource);
			async move { std::future::pending::<bool>().await }
		});
		tx.send_async("chunk\n".to_string()).await.expect("send chunk");
		drop(tx);

		let cancel = CancelToken::with_timeout(Some(Duration::from_millis(50)));
		let ok_result = Ok(ShellRunResult {
			exit_code:         Some(0),
			signal:            None,
			cancelled:         false,
			timed_out:         false,
			output_incomplete: false,
			captured_output:   None,
			minimized:         None,
			working_dir:       None,
		});
		let settled = time::timeout(
			Duration::from_secs(2),
			await_chunk_drain(Some(drain), &cancel, ok_result),
		)
		.await
		.expect("deadline must bound stalled drain after core completes");
		assert!(
			settled.is_err(),
			"stalled drain after normal core completion must surface an explicit error, not truncate silently",
		);
		assert!(
			callback_weak.upgrade().is_none(),
			"stalled pump task and callback resources must be released",
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_normal_slow_forward_preserves_full_output() {
		let (tx, rx) = flume::bounded::<String>(4);
		let received = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
		let received_clone = std::sync::Arc::clone(&received);
		let drain = spawn_test_drain(rx, move |payload: String| {
			let received_clone = std::sync::Arc::clone(&received_clone);
			async move {
				time::sleep(Duration::from_millis(10)).await;
				received_clone.lock().push_str(&payload);
				true
			}
		});
		tx.send_async("hello ".to_string()).await.expect("send 1");
		tx.send_async("world\n".to_string()).await.expect("send 2");
		drop(tx);

		let cancel = CancelToken::default();
		let ok_result = Ok(ShellRunResult {
			exit_code:         Some(0),
			signal:            None,
			cancelled:         false,
			timed_out:         false,
			output_incomplete: false,
			captured_output:   None,
			minimized:         None,
			working_dir:       None,
		});
		let settled = time::timeout(
			Duration::from_secs(2),
			await_chunk_drain(Some(drain), &cancel, ok_result),
		)
		.await
		.expect("slow healthy drain should finish")
		.expect("healthy drain should succeed");
		assert_eq!(settled.exit_code, Some(0));
		assert_eq!(received.lock().as_str(), "hello world\n");
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn shell_abort_without_signal_settles_stalled_drain_during_active_core() {
		let shell = Shell::new(None);
		let mut core_cancel = CancelToken::default();
		let run_guard = shell.active_runs.register(&mut core_cancel);
		let (tx, rx) = flume::bounded::<String>(4);
		let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
		let started_tx = std::sync::Arc::new(parking_lot::Mutex::new(Some(started_tx)));
		let callback_resource = std::sync::Arc::new(());
		let callback_weak = std::sync::Arc::downgrade(&callback_resource);
		let drain = spawn_test_drain(rx, move |payload: String| {
			if payload.contains("READY")
				&& let Some(tx) = started_tx.lock().take()
			{
				let _ = tx.send(());
			}
			let _keep_alive = std::sync::Arc::clone(&callback_resource);
			async move { std::future::pending::<bool>().await }
		});

		let inner = std::sync::Arc::clone(&shell.inner);
		let run_task = tokio::spawn(Shell::run_with_bridge(
			inner,
			run_guard,
			CoreShellRunOptions {
				command:       "sh -c 'echo READY; sleep 30'".to_string(),
				cwd:           None,
				env:           None,
				timeout_ms:    None,
				cpu_budget_id: None,
			},
			core_cancel,
			Some(tx),
			Some(drain),
		));

		time::timeout(Duration::from_secs(15), started_rx)
			.await
			.expect("external child output should reach on_chunk before Shell.abort()")
			.expect("forward started signal should not drop");
		assert_eq!(shell.active_runs.active_count(), 1);
		shell.abort().await.expect("Shell.abort should succeed");

		let settled = time::timeout(Duration::from_secs(5), run_task)
			.await
			.expect("Shell.abort() without signal must settle stalled drain during active core")
			.expect("run task should not panic")
			.expect("cancelled shell should return ShellRunResult");
		assert!(settled.cancelled, "expected cancelled=true");
		assert_eq!(shell.active_runs.active_count(), 0, "RAII guard must unregister run");
		assert!(
			callback_weak.upgrade().is_none(),
			"stalled pump task and callback resources must be released",
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn shell_abort_without_signal_settles_stalled_drain_after_core_completion() {
		let shell = Shell::new(None);
		let mut core_cancel = CancelToken::default();
		let run_guard = shell.active_runs.register(&mut core_cancel);
		let (tx, rx) = flume::bounded::<String>(4);
		let (started_tx, started_rx) = tokio::sync::oneshot::channel::<()>();
		let started_tx = std::sync::Arc::new(parking_lot::Mutex::new(Some(started_tx)));
		let callback_resource = std::sync::Arc::new(());
		let callback_weak = std::sync::Arc::downgrade(&callback_resource);
		let drain = spawn_test_drain(rx, move |payload: String| {
			if payload.contains("READY")
				&& let Some(tx) = started_tx.lock().take()
			{
				let _ = tx.send(());
			}
			let _keep_alive = std::sync::Arc::clone(&callback_resource);
			async move { std::future::pending::<bool>().await }
		});

		let inner = std::sync::Arc::clone(&shell.inner);
		let run_task = tokio::spawn(Shell::run_with_bridge(
			inner,
			run_guard,
			CoreShellRunOptions {
				command:       "sh -c 'echo READY'".to_string(),
				cwd:           None,
				env:           None,
				timeout_ms:    None,
				cpu_budget_id: None,
			},
			core_cancel,
			Some(tx),
			Some(drain),
		));

		time::timeout(Duration::from_secs(15), started_rx)
			.await
			.expect("short command output should reach on_chunk")
			.expect("forward started signal should not drop");
		time::sleep(Duration::from_millis(100)).await;
		assert_eq!(shell.active_runs.active_count(), 1);
		shell.abort().await.expect("Shell.abort should succeed");

		let settled = time::timeout(Duration::from_secs(5), run_task)
			.await
			.expect("Shell.abort() must settle stalled drain even after core completion")
			.expect("run task should not panic");
		assert!(
			settled.is_err(),
			"aborting stalled post-completion drain must return an explicit error, not truncate silently",
		);
		assert_eq!(shell.active_runs.active_count(), 0, "RAII guard must unregister run");
		assert!(
			callback_weak.upgrade().is_none(),
			"stalled pump task and callback resources must be released",
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_stalled_forward_after_success_with_default_none_options_returns_error() {
		let shell = Shell::new(None);
		let mut core_cancel = CancelToken::default();
		let run_guard = shell.active_runs.register(&mut core_cancel);
		let (tx, rx) = flume::bounded::<String>(4);
		let callback_resource = std::sync::Arc::new(());
		let callback_weak = std::sync::Arc::downgrade(&callback_resource);
		let drain = spawn_test_drain(rx, move |_payload: String| {
			let _keep_alive = std::sync::Arc::clone(&callback_resource);
			async move { std::future::pending::<bool>().await }
		});

		let inner = std::sync::Arc::clone(&shell.inner);
		let run_task = tokio::spawn(Shell::run_with_bridge(
			inner,
			run_guard,
			CoreShellRunOptions {
				command:       "sh -c 'echo READY'".to_string(),
				cwd:           None,
				env:           None,
				timeout_ms:    None,
				cpu_budget_id: None,
			},
			core_cancel,
			Some(tx),
			Some(drain),
		));

		let settled = time::timeout(Duration::from_secs(5), run_task)
			.await
			.expect("default None options must bound stalled drain after core completion")
			.expect("run task should not panic");
		assert!(
			settled.is_err(),
			"stalled drain after normal core completion with default options must surface an explicit error",
		);
		assert_eq!(shell.active_runs.active_count(), 0, "RAII guard must unregister run on error");
		assert!(
			callback_weak.upgrade().is_none(),
			"stalled pump task and callback resources must be released",
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_healthy_slow_forward_exceeding_idle_grace_preserves_all_output() {
		const CHUNKS: usize = 25;
		const CHUNK_BYTES: usize = 64 * 1024;
		let (tx, rx) = flume::bounded::<String>(CHUNKS);
		let received = std::sync::Arc::new(parking_lot::Mutex::new(String::new()));
		let received_clone = std::sync::Arc::clone(&received);
		let drain = spawn_test_drain(rx, move |payload: String| {
			let received_clone = std::sync::Arc::clone(&received_clone);
			async move {
				time::sleep(Duration::from_millis(100)).await;
				received_clone.lock().push_str(&payload);
				true
			}
		});
		let mut expected = String::with_capacity(CHUNKS * CHUNK_BYTES);
		for i in 0..CHUNKS {
			let chunk = format!("[{i:02}]{}", "a".repeat(CHUNK_BYTES - 4));
			expected.push_str(&chunk);
			tx.send_async(chunk).await.expect("send chunk");
		}
		drop(tx);

		let cancel = CancelToken::default();
		let ok_result = Ok(ShellRunResult {
			exit_code:         Some(0),
			signal:            None,
			cancelled:         false,
			timed_out:         false,
			output_incomplete: false,
			captured_output:   None,
			minimized:         None,
			working_dir:       None,
		});
		let settled = time::timeout(
			Duration::from_secs(10),
			await_chunk_drain(Some(drain), &cancel, ok_result),
		)
		.await
		.expect("healthy slow drain with ongoing progress should finish")
		.expect("healthy slow drain should succeed");
		assert_eq!(settled.exit_code, Some(0));
		assert_eq!(received.lock().len(), expected.len(), "output must not be truncated");
		assert_eq!(received.lock().as_str(), expected);
	}
}
