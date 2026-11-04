//! Terminal drawer scene construction (§5.6, §9.4).
//!
//! Deterministic scenes proving mono fidelity, 280px drawer layout,
//! multiple tabs, active vs inactive tabs, exited terminals, declined
//! terminals, ANSI 16/256/truecolour, text styles, CJK/emoji, box drawing,
//! progress bars, cursor shapes, selection highlights, and scrollback.

use veyyon_desktop_model::{
	Capability, CapabilityStatus, ProcessView, QueuePartition, TerminalScrollback, TerminalStatus,
	TerminalView,
	text::terminal::{SelectionKind, TerminalSelection},
};
use veyyon_desktop_surface::drawer::CursorShape;

use crate::scene::{
	SceneBuildError,
	seed::{Built, SCENE_CLOCK_MS, Seed},
};

/// Builds a deterministic scene for the terminal drawer surface.
pub fn drawer_scene(state: &str) -> Result<Built, SceneBuildError> {
	match state {
		"rest" => Ok(drawer_rest()),
		"multiple-terminals" => Ok(drawer_multiple_terminals()),
		"exited-terminal" => Ok(drawer_exited_terminal()),
		"declined" => Ok(drawer_declined()),
		"cjk-and-emoji" => Ok(drawer_cjk_and_emoji()),
		"ansi-and-truecolor" => Ok(drawer_ansi_and_truecolor()),
		"box-drawing-and-progress" => Ok(drawer_box_drawing_and_progress()),
		"styles-and-cursor" => Ok(drawer_styles_and_cursor()),
		"selection-and-scrollback" => Ok(drawer_selection_and_scrollback()),
		"process-supervisor" => Ok(drawer_process_supervisor()),
		other => Err(SceneBuildError::Unbuilt(format!("drawer/{other}"))),
	}
}

fn seed_drawer_base() -> (Seed, String) {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live);
	seed.exchange(&session, Seed::prose());
	seed.state.drawer_open = true;
	let term_id = "term_1".to_string();
	(seed, term_id)
}

fn add_terminal(seed: &mut Seed, id: &str, shell: &str, status: TerminalStatus, output: &[u8]) {
	seed.store.domains.terminals.push(TerminalView {
		id: id.to_string(),
		cwd: "/repo".to_string(),
		shell: shell.to_string(),
		cols: 80,
		rows: 24,
		status,
	});
	let mut scrollback = TerminalScrollback::new();
	scrollback.data = output.to_vec();
	seed
		.store
		.domains
		.terminal_output
		.insert(id.to_string(), scrollback);
}

fn drawer_rest() -> Built {
	let (mut seed, term_id) = seed_drawer_base();
	let output = b"$ cargo check\r\n   Compiling veyyon v1.0.0 (/repo)\r\n    Finished dev [unoptimized + debuginfo] in 2.14s\r\n$ ";
	add_terminal(&mut seed, &term_id, "bash", TerminalStatus::Running, output);
	let mut built = seed.finish();
	built.state.drawer.cursor_shape = CursorShape::Block;
	built
}

fn drawer_multiple_terminals() -> Built {
	let (mut seed, t1) = seed_drawer_base();
	let out1 = b"$ git status\r\nOn branch main\r\nnothing to commit, working tree clean\r\n$ ";
	add_terminal(&mut seed, &t1, "bash", TerminalStatus::Running, out1);
	let out2 = b"[watcher] watching /repo for changes...\r\n";
	add_terminal(&mut seed, "term_2", "cargo watch", TerminalStatus::Running, out2);
	let out3 = b"running 42 tests\r\ntest result: ok. 42 passed\r\n";
	add_terminal(&mut seed, "term_3", "test-runner", TerminalStatus::Running, out3);
	let mut built = seed.finish();
	built.state.drawer.active_tab = 0;
	built.state.drawer.cursor_shape = CursorShape::Block;
	built
}

fn drawer_exited_terminal() -> Built {
	let (mut seed, t1) = seed_drawer_base();
	let out1 = b"$ ./scripts/build-release.sh\r\nRelease bundle created at dist/release.tar.gz\r\nDone in 14.2s\r\n";
	add_terminal(&mut seed, &t1, "build-worker", TerminalStatus::Exited { code: 0 }, out1);
	let out2 = b"$ ";
	add_terminal(&mut seed, "term_2", "bash", TerminalStatus::Running, out2);
	let mut built = seed.finish();
	built.state.drawer.active_tab = 0;
	built
}

fn drawer_declined() -> Built {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live);
	seed.exchange(&session, Seed::prose());
	seed
		.store
		.capabilities
		.set(Capability::Terminals, CapabilityStatus::Unavailable {
			reason: "host declines pty allocation".to_string(),
		});
	seed
		.store
		.capabilities
		.set(Capability::ProcessSupervisor, CapabilityStatus::Unavailable {
			reason: "no supervisor installed".to_string(),
		});
	seed.state.drawer_open = true;
	seed.finish()
}

fn drawer_cjk_and_emoji() -> Built {
	let (mut seed, term_id) = seed_drawer_base();
	let output = concat!(
		"$ tree src/ -L 2\r\n",
		"├── \u{1f4e6} components/       \u{2502} 42 files\r\n",
		"\u{2502}   ├── \u{65e5}\u{672c}\u{8a9e}.rs        \u{2502} \u{6771}\u{4eac}, \
		 \u{5927}\u{962a}, \u{4eac}\u{90fd}\r\n",
		"\u{2502}   ├── \u{4e2d}\u{6587}\u{6d4b}\u{8bd5}.rs      \u{2502} \
		 \u{5feb}\u{901f}\u{7684}\u{68d5}\u{8272}\u{72d0}\u{72f8}\r\n",
		"\u{2502}   └── \u{d55c}\u{ad6d}\u{c5b4}.rs        \u{2502} \
		 \u{c548}\u{b155}\u{d558}\u{c138}\u{c694} \u{c138}\u{acc4}\r\n",
		"└── \u{1f680} deploy: 200 OK \u{2728}   \u{2502} production ready\r\n",
		"$ "
	)
	.as_bytes();
	add_terminal(&mut seed, &term_id, "bash", TerminalStatus::Running, output);
	let mut built = seed.finish();
	built.state.drawer.cursor_shape = CursorShape::Bar;
	built
}

fn drawer_ansi_and_truecolor() -> Built {
	let (mut seed, term_id) = seed_drawer_base();
	let output = concat!(
		"ANSI 16 Colours:\r\n",
		"\x1b[30m\u{25a0} blk \x1b[31m\u{25a0} red \x1b[32m\u{25a0} grn \x1b[33m\u{25a0} ylw \
		 \x1b[34m\u{25a0} blu \x1b[35m\u{25a0} mag \x1b[36m\u{25a0} cyn \x1b[37m\u{25a0} \
		 wht\x1b[0m\r\n",
		"\x1b[90m\u{25a0} brk \x1b[91m\u{25a0} brd \x1b[92m\u{25a0} bgn \x1b[93m\u{25a0} byl \
		 \x1b[94m\u{25a0} bbl \x1b[95m\u{25a0} bmg \x1b[96m\u{25a0} bcn \x1b[97m\u{25a0} \
		 bwt\x1b[0m\r\n",
		"256-Colour Palette:\r\n",
		"\x1b[38;5;196m\u{2588}\u{2588} \x1b[38;5;208m\u{2588}\u{2588} \
		 \x1b[38;5;226m\u{2588}\u{2588} \x1b[38;5;46m\u{2588}\u{2588} \x1b[38;5;21m\u{2588}\u{2588} \
		 \x1b[38;5;201m\u{2588}\u{2588} \x1b[38;5;244m\u{2588}\u{2588} \
		 \x1b[38;5;255m\u{2588}\u{2588}\x1b[0m\r\n",
		"24-bit Truecolour RGB:\r\n",
		"\x1b[48;2;240;80;40m\x1b[38;2;255;255;255m RGB 240,80,40 \x1b[0m \
		 \x1b[48;2;40;160;220m\x1b[38;2;255;255;255m RGB 40,160,220 \x1b[0m \
		 \x1b[48;2;50;200;120m\x1b[38;2;10;20;10m RGB 50,200,120 \x1b[0m\r\n",
		"$ "
	)
	.as_bytes();
	add_terminal(&mut seed, &term_id, "bash", TerminalStatus::Running, output);
	let mut built = seed.finish();
	built.state.drawer.cursor_shape = CursorShape::Underline;
	built
}

fn drawer_box_drawing_and_progress() -> Built {
	let (mut seed, term_id) = seed_drawer_base();
	let output = concat!(
		"\u{250c}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{252c}\u{2500}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{252c}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{252c}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2510}\r\n",
		"\u{2502} PID  \u{2502} Command              \u{2502} Status   \u{2502} CPU %  \u{2502}\r\n",
		"\u{251c}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{253c}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2524}\r\n",
		"\u{2502} 1420 \u{2502} veyyon-desktop       \u{2502} running  \u{2502}  12.4% \u{2502}\r\n",
		"\u{2502} 1421 \u{2502} cargo watch          \u{2502} watching \u{2502}   0.2% \u{2502}\r\n",
		"\u{2514}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2534}\u{2500}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2534}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2534}\u{2500}\u{2500}\\
		 u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2500}\u{2518}\r\n",
		"Progress: [\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\\
		 u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\u{2588}\\
		 u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}\u{2591}] 67% (42/63 \
		 MB)\r\n",
		"Building: [=======================>      ] 78% [342/438]\r\n"
	)
	.as_bytes();
	add_terminal(&mut seed, &term_id, "htop", TerminalStatus::Running, output);
	let mut built = seed.finish();
	built.state.drawer.cursor_shape = CursorShape::Block;
	built
}

fn drawer_styles_and_cursor() -> Built {
	let (mut seed, term_id) = seed_drawer_base();
	let output = concat!(
		"Text Styles Fidelity:\r\n",
		"Normal Text   : ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\r\n",
		"Bold Style    : \x1b[1mABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\x1b[0m\r\n",
		"Dim Style     : \x1b[2mABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\x1b[0m\r\n",
		"Italic Style  : \x1b[3mABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\x1b[0m\r\n",
		"Underline     : \x1b[4mABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\x1b[0m\r\n",
		"Strikethrough : \x1b[9mABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789\x1b[0m\r\n",
		"Inverse Style : \x1b[7m INVERTED FOREGROUND & BACKGROUND \x1b[0m\r\n"
	)
	.as_bytes();
	add_terminal(&mut seed, &term_id, "bash", TerminalStatus::Running, output);
	let mut built = seed.finish();
	built.state.drawer.cursor_shape = CursorShape::HollowBlock;
	built
}

fn drawer_selection_and_scrollback() -> Built {
	let (mut seed, term_id) = seed_drawer_base();
	let output = concat!(
		"[scrollback -12] system initialization complete\r\n",
		"[scrollback -11] listening on 127.0.0.1:8080\r\n",
		"[scrollback -10] connection accepted from client #1\r\n",
		"Selected Line : highlight text selection test\r\n",
		"Normal text row in terminal grid\r\n"
	)
	.as_bytes();
	add_terminal(&mut seed, &term_id, "bash", TerminalStatus::Running, output);
	let mut built = seed.finish();
	built.state.drawer.scroll_offset = 12;
	built.state.drawer.selection = Some(TerminalSelection {
		start_col: 16,
		start_row: 3,
		end_col:   44,
		end_row:   3,
		kind:      SelectionKind::Linear,
	});
	built
}

fn drawer_process_supervisor() -> Built {
	let mut seed = Seed::attached();
	let session = seed.session(QueuePartition::Live);
	seed.exchange(&session, Seed::prose());
	seed.state.drawer_open = true;
	seed.store.domains.processes = vec![
		ProcessView {
			name:          "web-server".to_string(),
			pid:           Some(1024),
			status:        "running".to_string(),
			application:   "cargo".to_string(),
			args:          vec!["run".to_string(), "--bin".to_string(), "web".to_string()],
			cwd:           "/repo".to_string(),
			lifetime:      "session".to_string(),
			started_at_ms: SCENE_CLOCK_MS - 60_000,
			exit_code:     None,
			terminated_by: None,
		},
		ProcessView {
			name:          "db-sync".to_string(),
			pid:           Some(1025),
			status:        "running".to_string(),
			application:   "sqlite3".to_string(),
			args:          vec!["local.db".to_string()],
			cwd:           "/repo".to_string(),
			lifetime:      "session".to_string(),
			started_at_ms: SCENE_CLOCK_MS - 45_000,
			exit_code:     None,
			terminated_by: None,
		},
	];
	let mut built = seed.finish();
	built.state.drawer.active_tab = 0; // Processes tab
	built
}
