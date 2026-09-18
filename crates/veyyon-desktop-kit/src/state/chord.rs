//! The chord vocabulary: what a keyboard shortcut is made of, and how the
//! keymap grammar reads one (§5.14).
//!
//! `primary` is the one modifier that resolves per platform, so a keymap
//! states an intent once and each platform reads its own command modifier
//! rather than the keymap carrying two spellings of the same chord.

use veyyon_gpui::SharedString;

/// Keyboard shortcut chord representation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KeyChord {
	pub key:   SharedString,
	pub ctrl:  bool,
	pub alt:   bool,
	pub shift: bool,
	pub meta:  bool,
}

impl KeyChord {
	/// Creates a single key chord with no modifiers.
	#[must_use]
	pub fn key(key: impl Into<SharedString>) -> Self {
		Self { key: key.into(), ctrl: false, alt: false, shift: false, meta: false }
	}

	/// Reads a chord in the keymap grammar: modifiers and the key joined by
	/// `-`, as in `ctrl-shift-k` or `cmd-,`. The key is the last part;
	/// `primary` is read as the platform's command modifier, and a chord that
	/// ends in `-` has `-` as its key.
	#[must_use]
	pub fn parse(chord: &str) -> Self {
		let (modifiers, key) = match chord.rsplit_once('-') {
			Some((modifiers, "")) => (modifiers.trim_end_matches('-'), "-"),
			Some((modifiers, key)) => (modifiers, key),
			None => ("", chord),
		};
		let mut parsed = Self::key(key.to_owned());
		for modifier in modifiers.split('-').filter(|part| !part.is_empty()) {
			match modifier.to_ascii_lowercase().as_str() {
				"ctrl" | "control" => parsed.ctrl = true,
				"alt" | "option" => parsed.alt = true,
				"shift" => parsed.shift = true,
				"cmd" | "meta" | "super" => parsed.meta = true,
				"primary" if cfg!(target_os = "macos") => parsed.meta = true,
				"primary" => parsed.ctrl = true,
				_ => {},
			}
		}
		parsed
	}

	/// Attaches command/meta modifier.
	#[must_use]
	pub fn meta(mut self) -> Self {
		self.meta = true;
		self
	}

	/// Attaches ctrl modifier.
	#[must_use]
	pub fn ctrl(mut self) -> Self {
		self.ctrl = true;
		self
	}

	/// Attaches alt modifier.
	#[must_use]
	pub fn alt(mut self) -> Self {
		self.alt = true;
		self
	}

	/// Attaches shift modifier.
	#[must_use]
	pub fn shift(mut self) -> Self {
		self.shift = true;
		self
	}

	/// Returns active modifier strings.
	#[must_use]
	pub fn modifiers(&self) -> Vec<&'static str> {
		let mut list = Vec::new();
		if self.ctrl {
			list.push("Ctrl");
		}
		if self.alt {
			list.push("Alt");
		}
		if self.shift {
			list.push("Shift");
		}
		if self.meta {
			list.push("Cmd");
		}
		list
	}
}
