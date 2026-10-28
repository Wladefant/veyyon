//! WHY: brush kept a running count of the variables in its environment and
//! added to it whenever a variable entered a scope, but popping a scope never
//! subtracted that scope's variables. Every command pushes a scope, and the
//! host's bash tool hands each run its whole environment, so the count grew by
//! about seventy for every bash call for the life of the session. Every
//! builtin and every spawned program collects the exported environment into a
//! map sized from that count: after 12 000 bash calls each `seq` allocated a
//! map for 840 000 variables, and the process held 81 MiB it never got back.
//!
//! The class closed is any scope whose variables outlive it in the size of
//! that collection, for each of the three places a scope is pushed: the
//! host's per-run environment, a prefix assignment (`A=1 cmd`), and a
//! function's `local` variables. Each is repeated, and the largest single
//! allocation of one later builtin is read from a counting allocator and held
//! to what it was after the first repetition.
//!
//! What it does not catch: a scope pushed and never popped, whose variables
//! would then be live and rightly collected; and a collection sized from
//! something other than the environment.

use std::{
	alloc::{GlobalAlloc, Layout, System},
	collections::HashMap,
	fmt::Write as _,
	sync::atomic::{AtomicUsize, Ordering},
};

use veyyon_shell::{Shell, ShellRunOptions, cancel::CancelToken};

/// The largest single block requested since the last reset. The binary holds
/// one test, so no other test's allocations reach it.
static LARGEST: AtomicUsize = AtomicUsize::new(0);

/// The system allocator with a largest-block counter in front of it.
struct Counting;

// SAFETY: every method forwards to the system allocator with the pointer and
// layout it was given, and the counter is an atomic that allocates nothing.
unsafe impl GlobalAlloc for Counting {
	unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
		LARGEST.fetch_max(layout.size(), Ordering::Relaxed);
		// SAFETY: the layout is the caller's, forwarded unchanged.
		unsafe { System.alloc(layout) }
	}

	unsafe fn dealloc(&self, pointer: *mut u8, layout: Layout) {
		// SAFETY: pointer and layout are the pair this allocator handed out.
		unsafe { System.dealloc(pointer, layout) };
	}

	unsafe fn realloc(&self, pointer: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
		LARGEST.fetch_max(new_size, Ordering::Relaxed);
		// SAFETY: pointer and layout are the pair this allocator handed out, and
		// `new_size` is the caller's.
		unsafe { System.realloc(pointer, layout, new_size) }
	}
}

#[global_allocator]
static ALLOCATOR: Counting = Counting;

/// Variables each repetition puts in a scope, about what the host's bash tool
/// passes per run.
const VARIABLES: usize = 64;

/// Repetitions between the two measurements. Before the fix this left the
/// count at 128 000 and the collection at 4 MiB.
const REPEATS: usize = 2_000;

/// The three places a scope is pushed around a command.
#[derive(Clone, Copy, Debug)]
enum Scope {
	/// `ShellRunOptions::env`, applied to a fresh command scope for one run.
	RunEnvironment,
	/// `V0=0 V1=1 … true`: the interpreter's command scope.
	PrefixAssignment,
	/// `local V0=0 V1=1 …` inside a called function: the call frame's scope.
	FunctionLocals,
}

const SCOPES: [Scope; 3] = [Scope::RunEnvironment, Scope::PrefixAssignment, Scope::FunctionLocals];

fn assignments() -> String {
	let mut words = String::new();
	for index in 0..VARIABLES {
		let _ = write!(words, "V{index}={index} ");
	}
	words
}

async fn run(shell: &Shell, command: &str, env: Option<HashMap<String, String>>) {
	let options = ShellRunOptions { command: command.to_owned(), env, ..ShellRunOptions::default() };
	let result = shell
		.run(options, None, CancelToken::default())
		.await
		.expect("shell run");
	assert_eq!(result.exit_code, Some(0), "`{command}` failed");
}

/// Push and pop `scope` with [`VARIABLES`] variables in it, `times` times.
async fn repeat(shell: &Shell, scope: Scope, times: usize) {
	match scope {
		Scope::RunEnvironment => {
			let env: HashMap<String, String> = (0..VARIABLES)
				.map(|index| (format!("V{index}"), index.to_string()))
				.collect();
			for _ in 0..times {
				run(shell, "true", Some(env.clone())).await;
			}
		},
		Scope::PrefixAssignment => {
			let command = format!("for ((i = 0; i < {times}; i++)); do {} true; done", assignments());
			run(shell, &command, None).await;
		},
		Scope::FunctionLocals => {
			let command = format!(
				"f() {{ local {}; }}; for ((i = 0; i < {times}; i++)); do f; done",
				assignments().trim_end()
			);
			run(shell, &command, None).await;
		},
	}
}

/// The largest single block one `seq` allocates. `seq` is a uutils builtin,
/// which collects the exported environment the way every builtin and every
/// spawned program does.
async fn largest_block_of_one_builtin(shell: &Shell) -> usize {
	LARGEST.store(0, Ordering::Relaxed);
	run(shell, "seq 1 2", None).await;
	LARGEST.load(Ordering::Relaxed)
}

#[tokio::test(flavor = "multi_thread")]
async fn a_popped_scope_leaves_nothing_in_what_a_later_command_allocates() {
	let mut grown = Vec::new();
	for scope in SCOPES {
		let shell = Shell::new(None);
		repeat(&shell, scope, 1).await;
		let first = largest_block_of_one_builtin(&shell).await;
		repeat(&shell, scope, REPEATS).await;
		let later = largest_block_of_one_builtin(&shell).await;
		if later > first {
			grown.push(format!(
				"{scope:?}: after {REPEATS} more repetitions one `seq` allocated a {later}-byte \
				 block, after the first at most {first} bytes"
			));
		}
	}
	assert!(grown.is_empty(), "{grown:#?}");
}
