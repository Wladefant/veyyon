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

/// Idle callbacks fail promptly; progress cannot extend the absolute deadline
/// because a surviving child can keep the output channel open indefinitely.
const POST_COMPLETION_DRAIN_IDLE_GRACE: Duration = Duration::from_secs(1);
const POST_COMPLETION_DRAIN_DEADLINE: Duration = Duration::from_secs(3);

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

// Adopted from oh-my-pi's shell bridge (#12657 and #10308). A deadline applies
// to one callback, not the whole transcript: progressing output remains
// lossless.
const FORWARD_STALL_TIMEOUT: Duration = Duration::from_secs(30);

// The fallback is diagnostic evidence, not a second unbounded transcript.
const DRAIN_CAPTURE_BYTES: usize = 64 * 1024;

struct ChunkDrain {
	handle:      napi::tokio::task::JoinHandle<bool>,
	progress_rx: napi::tokio::sync::watch::Receiver<u64>,
	prefix:      Arc<parking_lot::Mutex<String>>,
}

fn bridge_chunks(
	on_chunk: Option<ThreadsafeFunction<String, UnknownReturnValue>>,
) -> (Option<flume::Sender<String>>, Option<ChunkDrain>) {
	let Some(on_chunk) = on_chunk else {
		return (None, None);
	};
	let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
	let (progress_tx, progress_rx) = napi::tokio::sync::watch::channel(0u64);
	let prefix = Arc::new(parking_lot::Mutex::new(String::new()));
	let handle = napi::tokio::spawn(pump_chunks_with_progress(
		rx,
		Some(progress_tx),
		Some(Arc::clone(&prefix)),
		async move |payload: String| {
			// `call_async` resolves only after the JS callback ran, so at most
			// one batch sits in the napi queue at a time and the JS event loop's
			// actual consumption rate backpressures the whole pipeline. An error
			// means the JS side is gone (env teardown) — stop forwarding.
			on_chunk.call_async(Ok(payload)).await.is_ok()
		},
	));
	(Some(tx), Some(ChunkDrain { handle, progress_rx, prefix }))
}

fn retain_incomplete_drain(
	result: &mut Result<ShellRunResult>,
	accepted_output: bool,
	prefix: &parking_lot::Mutex<String>,
) {
	if let Ok(res) = result {
		res.output_incomplete = true;
		// The TS sink treats captured_output as authoritative replacement. Once
		// callbacks have succeeded, keep its streamed tail rather than replace it
		// with an older prefix. An existing core capture remains authoritative.
		if res.captured_output.is_none() && !accepted_output {
			let captured = std::mem::take(&mut *prefix.lock());
			if !captured.is_empty() {
				res.captured_output = Some(captured);
			}
		}
	}
}

async fn await_chunk_drain(
	drain: Option<ChunkDrain>,
	cancel_token: &CoreCancelToken,
	mut result: Result<ShellRunResult>,
) -> Result<ShellRunResult> {
	let Some(ChunkDrain { mut handle, mut progress_rx, prefix }) = drain else {
		return result;
	};
	let allow_cancel_abort = !matches!(&result, Ok(res) if res.cancelled || res.timed_out);
	let idle_sleep = napi::tokio::time::sleep(POST_COMPLETION_DRAIN_IDLE_GRACE);
	napi::tokio::pin!(idle_sleep);
	let deadline_sleep = napi::tokio::time::sleep(POST_COMPLETION_DRAIN_DEADLINE);
	napi::tokio::pin!(deadline_sleep);
	let mut progress_open = true;
	loop {
		tokio::select! {
			biased;
			completed = &mut handle => {
				if !matches!(completed, Ok(true)) {
					retain_incomplete_drain(&mut result, *progress_rx.borrow() != 0, &prefix);
				}
				return result;
			}
			_ = cancel_token.wait(), if allow_cancel_abort => {
				handle.abort();
				let _ = handle.await;
				retain_incomplete_drain(&mut result, *progress_rx.borrow() != 0, &prefix);
				return result;
			}
			() = &mut deadline_sleep => {
				handle.abort();
				let _ = handle.await;
				retain_incomplete_drain(&mut result, *progress_rx.borrow() != 0, &prefix);
				return result;
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
				retain_incomplete_drain(&mut result, *progress_rx.borrow() != 0, &prefix);
				return result;
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
async fn pump_chunks(rx: flume::Receiver<String>, forward: impl AsyncFnMut(String) -> bool) -> bool {
	pump_chunks_with_progress(rx, None, None, forward).await
}

async fn pump_chunks_with_progress(
	rx: flume::Receiver<String>,
	progress_tx: Option<napi::tokio::sync::watch::Sender<u64>>,
	prefix: Option<Arc<parking_lot::Mutex<String>>>,
	mut forward: impl AsyncFnMut(String) -> bool,
) -> bool {
	// Hard cap on one coalesced batch so the JS main thread never sees a
	// multi-MB napi callback (a giant single string would stall sanitize +
	// tail-buffer maintenance for the whole copy).
	const MAX_BATCH_BYTES: usize = 64 * 1024;
	// Initial capacity sized for typical bursty pipe output. Re-allocated
	// each batch because `String` ownership is moved into the napi call.
	const INITIAL_BATCH_CAP: usize = 8 * 1024;
	let mut batch = String::with_capacity(INITIAL_BATCH_CAP);
	let mut seq = 0u64;
	let mut prefix_closed = false;
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
		if !prefix_closed && let Some(prefix) = &prefix {
			let mut captured = prefix.lock();
			let mut end = (DRAIN_CAPTURE_BYTES - captured.len()).min(batch.len());
			while !batch.is_char_boundary(end) {
				end -= 1;
			}
			captured.push_str(&batch[..end]);
			prefix_closed = end < batch.len() || captured.len() == DRAIN_CAPTURE_BYTES;
		}
		let payload = std::mem::replace(&mut batch, String::with_capacity(INITIAL_BATCH_CAP));
		// Disconnect a wedged JS consumer so readers and child writers can continue.
		let forwarded = napi::tokio::time::timeout(FORWARD_STALL_TIMEOUT, forward(payload)).await;
		if !matches!(forwarded, Ok(true)) {
			return false;
		}
		if let Some(tx) = &progress_tx {
			seq = seq.wrapping_add(1);
			let _ = tx.send(seq);
		}
	}
	true
}

#[cfg(test)]
mod tests {
	use std::{
		sync::Arc,
		time::Duration,
	};

	use flume;
	use tokio::time;
	use veyyon_shell::{
		ShellRunOptions as CoreShellRunOptions,
		cancel::{AbortReason, CancelToken},
	};

	use super::{
		BRIDGE_QUEUE_CHUNKS, DRAIN_CAPTURE_BYTES, ChunkDrain, CoreShell, Shell, ShellRunResult,
		await_chunk_drain, pump_chunks, pump_chunks_with_progress,
	};

	fn spawn_test_drain<F, Fut>(rx: flume::Receiver<String>, mut forward: F) -> ChunkDrain
	where
		F: FnMut(String) -> Fut + Send + 'static,
		Fut: Future<Output = bool> + Send,
	{
		let (progress_tx, progress_rx) = tokio::sync::watch::channel(0u64);
		let prefix = Arc::new(parking_lot::Mutex::new(String::new()));
		let handle = tokio::spawn(pump_chunks_with_progress(
			rx,
			Some(progress_tx),
			Some(Arc::clone(&prefix)),
			async move |payload: String| forward(payload).await,
		));
		ChunkDrain { handle, progress_rx, prefix }
	}

	#[tokio::test]
	async fn diagnostic_prefix_is_utf8_bounded_without_skipping_into_later_chunks() {
		let (tx, rx) = flume::bounded::<String>(2);
		let expected = "a".repeat(DRAIN_CAPTURE_BYTES - 1);
		tx.send(format!("{expected}💥")).expect("first chunk");
		tx.send("later".to_string()).expect("second chunk");
		drop(tx);
		let prefix = Arc::new(parking_lot::Mutex::new(String::new()));
		assert!(
			pump_chunks_with_progress(rx, None, Some(Arc::clone(&prefix)), async |_| true).await,
		);
		assert_eq!(prefix.lock().as_str(), expected);
	}

	#[tokio::test]
	async fn callback_failure_preserves_the_original_core_error() {
		let (tx, rx) = flume::bounded::<String>(1);
		tx.send("diagnostic".to_string()).expect("chunk");
		drop(tx);
		let drain = spawn_test_drain(rx, |_| async { false });
		let Err(error) = await_chunk_drain(
			Some(drain),
			&CancelToken::default(),
			Err(napi::Error::from_reason("original core failure")),
		)
		.await else {
			panic!("transport failure must not replace the core error");
		};
		assert_eq!(error.reason, "original core failure");
	}

	fn drain_result(cancelled: bool, timed_out: bool) -> napi::Result<ShellRunResult> {
		Ok(ShellRunResult {
			exit_code: Some(0),
			signal: None,
			cancelled,
			timed_out,
			output_incomplete: false,
			captured_output: None,
			minimized: None,
			working_dir: None,
		})
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn completed_stderr_failure_survives_stalled_callback() {
		let shell = CoreShell::new(None);
		let cancel = CancelToken::default();
		let (tx, rx) = flume::bounded::<String>(4);
		let (started_tx, started_rx) = tokio::sync::oneshot::channel();
		let started_tx = Arc::new(parking_lot::Mutex::new(Some(started_tx)));
		let drain = spawn_test_drain(rx, move |_payload: String| {
			if let Some(tx) = started_tx.lock().take() {
				let _ = tx.send(());
			}
			async { std::future::pending::<bool>().await }
		});
		let core_result = shell
			.run(
				CoreShellRunOptions {
					command: "printf 'DRAIN_DIAGNOSTIC\\n' >&2; exit 5".to_string(),
					cwd: None,
					env: None,
					timeout_ms: None,
					cpu_budget_id: None,
				},
				Some(tx),
				cancel.clone(),
			)
			.await
			.expect("the finite core command must finish");
		assert_eq!(core_result.exit_code, Some(5));
		time::timeout(Duration::from_secs(5), started_rx)
			.await
			.expect("stderr must enter the production pump")
			.expect("the callback must start");
		let result = await_chunk_drain(Some(drain), &cancel, Ok(core_result.into()))
			.await
			.expect("a stalled callback must not replace the completed command outcome");
		assert_eq!(result.exit_code, Some(5));
		assert!(result.output_incomplete, "callback delivery did not finish");
		assert_eq!(result.captured_output.as_deref(), Some("DRAIN_DIAGNOSTIC\n"));
		assert!(!result.cancelled);
		assert!(!result.timed_out);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn interrupted_drain_disconnects_orphaned_senders() {
		for (cancelled, timed_out) in [(true, false), (false, true)] {
			let (orphan, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
			let drain = spawn_test_drain(rx, |_payload: String| async { true });
			let cancel = CancelToken::default();
			let result = time::timeout(
				Duration::from_secs(5),
				await_chunk_drain(Some(drain), &cancel, drain_result(cancelled, timed_out)),
			)
			.await
			.expect("interrupted drain must not wait for an orphaned sender");
			assert!(orphan.send("late".to_string()).is_err(), "drain must disconnect the orphan");
			assert!(
				result.expect("native result").output_incomplete,
				"abandoned output must be marked incomplete"
			);
		}
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn successful_and_failed_runs_preserve_slow_accepted_output() {
		for failed in [false, true] {
			let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
			let received = Arc::new(parking_lot::Mutex::new(String::new()));
			let observed = Arc::clone(&received);
			let drain = spawn_test_drain(rx, move |payload: String| {
				let observed = Arc::clone(&observed);
				async move {
					time::sleep(Duration::from_millis(500)).await;
					observed.lock().push_str(&payload);
					true
				}
			});
			for _ in 0..4 {
				tx.send("accepted".to_string()).expect("connected");
			}
			drop(tx);
			let cancel = CancelToken::default();
			let result = if failed {
				Err(napi::Error::from_reason("run failed"))
			} else {
				drain_result(false, false)
			};
			let result = time::timeout(
				Duration::from_secs(5),
				await_chunk_drain(Some(drain), &cancel, result),
			)
			.await
			.expect("accepted output must finish draining");
			assert_eq!(received.lock().as_str(), "acceptedacceptedacceptedaccepted", "accepted output must not be dropped");
			if let Ok(result) = result {
				assert!(!result.output_incomplete, "fully drained output must remain complete");
			}
		}
	}

	#[tokio::test]
	async fn abandoned_forward_reports_incomplete_output() {
		let (tx, rx) = flume::bounded::<String>(1);
		tx.send("accepted".to_string()).expect("connected");
		drop(tx);
		let drain = spawn_test_drain(rx, |_payload: String| async { false });
		let cancel = CancelToken::default();
		let result = await_chunk_drain(Some(drain), &cancel, drain_result(false, false)).await;
		assert!(result.expect("native result").output_incomplete);
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

	#[tokio::test(flavor = "multi_thread")]
	async fn stalled_bridge_callbacks_release_concurrent_producers() {
		let mut runs = tokio::task::JoinSet::new();
		for _ in 0..32 {
			runs.spawn(async {
				let (tx, rx) = flume::bounded::<String>(BRIDGE_QUEUE_CHUNKS);
				let pump = tokio::spawn(pump_chunks(rx, async |_payload: String| {
					std::future::pending::<bool>().await
				}));
				let producer = tokio::spawn(async move {
					for _ in 0..BRIDGE_QUEUE_CHUNKS + 2 {
						if tx.send_async("x".repeat(64 * 1024)).await.is_err() {
							return;
						}
					}
					panic!("stalled consumer must disconnect its producer");
				});
				let completed = time::timeout(Duration::from_secs(32), async {
					producer.await.expect("producer");
					assert!(
						!pump.await.expect("pump"),
						"stalled forwarding must report incomplete capture"
					);
				})
				.await;
				assert!(completed.is_ok(), "a stalled JS callback must not retain the bridge forever");
			});
		}
		while let Some(result) = runs.join_next().await {
			result.expect("every concurrent bridge must recover");
		}
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
	async fn drain_stalled_forward_after_success_retains_outcome_on_deadline() {
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
		.expect("deadline must bound stalled drain after core completes")
		.expect("callback failure must preserve the completed command");
		assert_eq!(settled.exit_code, Some(0));
		assert!(settled.output_incomplete);
		assert_eq!(settled.captured_output.as_deref(), Some("chunk\n"));
		assert!(!settled.cancelled);
		assert!(!settled.timed_out);
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

		let core_result = shell
			.inner
			.run(
				CoreShellRunOptions {
					command:       "sh -c 'echo READY'".to_string(),
					cwd:           None,
					env:           None,
					timeout_ms:    None,
					cpu_budget_id: None,
				},
				Some(tx),
				core_cancel.clone(),
			)
			.await
			.map(ShellRunResult::from)
			.map_err(crate::napi_error::to_napi);
		assert!(
			core_result
				.as_ref()
				.is_ok_and(|res| !res.cancelled && !res.timed_out && res.exit_code == Some(0)),
			"core command must finish cleanly before testing post-completion abort",
		);
		time::timeout(Duration::from_secs(15), started_rx)
			.await
			.expect("short command output should reach on_chunk")
			.expect("forward started signal should not drop");
		assert_eq!(shell.active_runs.active_count(), 1);
		let drain_task = tokio::spawn(async move {
			let _run_guard = run_guard;
			await_chunk_drain(Some(drain), &core_cancel, core_result).await
		});
		shell.abort().await.expect("Shell.abort should succeed");

		let settled = time::timeout(Duration::from_secs(5), drain_task)
			.await
			.expect("Shell.abort() must settle stalled drain even after core completion")
			.expect("drain task should not panic")
			.expect("late abort must preserve the completed command");
		assert_eq!(settled.exit_code, Some(0));
		assert!(settled.output_incomplete);
		assert!(!settled.cancelled);
		assert!(!settled.timed_out);
		assert_eq!(shell.active_runs.active_count(), 0, "RAII guard must unregister run");
		assert!(
			callback_weak.upgrade().is_none(),
			"stalled pump task and callback resources must be released",
		);
	}

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_stalled_forward_after_success_with_default_none_options_retains_result() {
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

		let settled = time::timeout(Duration::from_secs(15), run_task)
			.await
			.expect("default None options must bound stalled drain after core completion")
			.expect("run task should not panic")
			.expect("default options must retain the completed command");
		assert_eq!(settled.exit_code, Some(0));
		assert!(settled.output_incomplete);
		assert_eq!(shell.active_runs.active_count(), 0, "RAII guard must unregister run");
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

	#[tokio::test(flavor = "multi_thread")]
	async fn drain_continuous_child_output_after_success_hits_absolute_deadline() {
		use std::sync::atomic::{AtomicUsize, Ordering};

		use tokio::io::{AsyncBufReadExt, BufReader};

		let shell = Shell::new(None);
		let core_cancel = CancelToken::default();
		let core_result = shell
			.inner
			.run(
				CoreShellRunOptions {
					command:       "sh -c 'echo READY'".to_string(),
					cwd:           None,
					env:           None,
					timeout_ms:    None,
					cpu_budget_id: None,
				},
				None,
				core_cancel.clone(),
			)
			.await
			.map(ShellRunResult::from)
			.map_err(crate::napi_error::to_napi);
		assert!(
			core_result
				.as_ref()
				.is_ok_and(|res| !res.cancelled && !res.timed_out && res.exit_code == Some(0)),
			"core command must finish cleanly before testing continuous post-completion drain",
		);

		#[cfg(windows)]
		let mut child = {
			const CREATE_NO_WINDOW: u32 = 0x0800_0000;
			tokio::process::Command::new("powershell")
				.args([
					"-NoProfile",
					"-NonInteractive",
					"-WindowStyle",
					"Hidden",
					"-Command",
					"while ($true) { [Console]::Out.WriteLine('tick'); Start-Sleep -Milliseconds 30 }",
				])
				.creation_flags(CREATE_NO_WINDOW)
				.stdin(std::process::Stdio::null())
				.stdout(std::process::Stdio::piped())
				.stderr(std::process::Stdio::null())
				.kill_on_drop(true)
				.spawn()
				.expect("spawn continuous output child")
		};
		#[cfg(not(windows))]
		let mut child = tokio::process::Command::new("sh")
			.arg("-c")
			.arg("while :; do printf 'tick\\n'; sleep 0.03; done")
			.stdin(std::process::Stdio::null())
			.stdout(std::process::Stdio::piped())
			.stderr(std::process::Stdio::null())
			.kill_on_drop(true)
			.spawn()
			.expect("spawn continuous output child");
		let stdout = child.stdout.take().expect("child stdout must be piped");

		let (tx, rx) = flume::bounded::<String>(4);
		let retained_tx = tx.clone();
		let reader_task = tokio::spawn(async move {
			let mut lines = BufReader::new(stdout).lines();
			while let Ok(Some(line)) = lines.next_line().await {
				if tx.send_async(format!("{line}\n")).await.is_err() {
					break;
				}
			}
		});

		let delivered = std::sync::Arc::new(AtomicUsize::new(0));
		let delivered_clone = std::sync::Arc::clone(&delivered);
		let callback_resource = std::sync::Arc::new(());
		let callback_weak = std::sync::Arc::downgrade(&callback_resource);
		let drain = spawn_test_drain(rx, move |_payload: String| {
			let delivered_clone = std::sync::Arc::clone(&delivered_clone);
			let _keep_alive = std::sync::Arc::clone(&callback_resource);
			async move {
				delivered_clone.fetch_add(1, Ordering::SeqCst);
				true
			}
		});

		let settled_result = time::timeout(
			Duration::from_secs(4),
			await_chunk_drain(Some(drain), &core_cancel, core_result),
		)
		.await;
		let receiver_dropped = retained_tx.is_disconnected();

		let _ = child.kill().await;
		let _ = child.wait().await;
		reader_task.abort();
		let _ = reader_task.await;
		drop(retained_tx);

		let settled = settled_result
			.expect("continuous post-completion child output must hit absolute drain deadline within 4s")
			.expect("the completed command outcome must survive the deadline");
		assert_eq!(settled.exit_code, Some(0));
		assert!(settled.output_incomplete);
		assert!(settled.captured_output.is_none(), "do not replace accepted streamed output with an old prefix");
		assert!(
			delivered.load(Ordering::SeqCst) >= 3,
			"expected several chunks to be delivered before hitting absolute deadline",
		);
		assert!(
			receiver_dropped,
			"await_chunk_drain must drop the chunk receiver when hitting absolute deadline",
		);
		assert!(
			callback_weak.upgrade().is_none(),
			"pump task and callback resources must be released",
		);
	}
}
