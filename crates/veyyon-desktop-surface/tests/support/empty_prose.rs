//! What counts as a step out of an empty surface, for the two sweeps that
//! judge one: the settings sheet's pages and the panel's tenants. One
//! vocabulary, so a sentence that would fail beside a panel tenant fails
//! beside a settings page as well.

/// The phrasings that predict what arrives instead of stating a step. An
/// operator can do nothing with any of them.
const PREDICTIONS: [&str; 6] =
	["will appear", "will be", "appears here", "is shown", "is displayed", "once available"];

/// The verbs a step opens with, which is the record of what counts as one. A
/// surface whose step opens on anything else turns its sweep red until its verb
/// is written down here. A sentence that opens on a noun or a negation is
/// describing the condition again rather than asking for anything.
const STEP_VERBS: [&str; 17] = [
	"attach",
	"check",
	"clear",
	"click",
	"configure",
	"create",
	"declare",
	"edit",
	"install",
	"open",
	"select",
	"send",
	"set",
	"sign",
	"start",
	"submit",
	"verify",
];

/// The openers that report a read in flight rather than a step. Waiting is not
/// something to act on, and telling an operator to wait is not a step either.
const PROGRESS_VERBS: [&str; 4] = ["building", "inspecting", "loading", "scanning"];

/// What a sentence in the step's place turned out to be.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Prose {
	/// Something to do, opening on a recorded verb.
	Step,
	/// A read in flight, which the sweep pins by exact equality instead.
	Progress,
}

/// `sentence` without its whitespace, which is how two are compared and how one
/// the column wrapped is looked for in a frame.
#[must_use]
pub fn squeezed(sentence: &str) -> String {
	sentence
		.chars()
		.filter(|character| !character.is_whitespace())
		.collect()
}

/// Asserts that `action` is a step out of `condition`, and states which of the
/// two it turned out to be. `label` names the surface in every failure.
///
/// # Panics
///
/// When either sentence is empty, either ends on a full stop, the step
/// restates the condition, the step predicts what arrives, or the step opens
/// on an unrecorded word.
pub fn judge(label: &str, condition: &str, action: &str) -> Prose {
	assert!(!condition.trim().is_empty(), "{label} states an empty condition");
	assert!(!action.trim().is_empty(), "{label} states an empty step");
	// Neither line takes a full stop. The two are the lines of a state rather
	// than prose, the step has never carried one, and a page that ended its
	// condition on one read as a different kind of sentence from the tenant
	// beside it. An ellipsis is not a full stop: it reports a read in flight.
	for (line, which) in [(condition, "condition"), (action, "step")] {
		let trimmed = line.trim_end();
		assert!(
			!trimmed.ends_with('.') || trimmed.ends_with("..."),
			"{label} ends its {which} on a full stop, stated {line:?}"
		);
	}
	assert_ne!(
		squeezed(condition).to_lowercase(),
		squeezed(action).to_lowercase(),
		"{label} restates its condition where the step belongs"
	);
	let lowered = action.to_lowercase();
	for prediction in PREDICTIONS {
		assert!(
			!lowered.contains(prediction),
			"{label} predicts {prediction:?} instead of stating a step"
		);
	}
	let opener = lowered.split_whitespace().next().unwrap_or_default();
	if PROGRESS_VERBS.contains(&opener) {
		return Prose::Progress;
	}
	assert!(
		STEP_VERBS.contains(&opener),
		"{label} opens its step on {opener:?}, which is neither a step to take nor a recorded verb"
	);
	// A step states what to do and where, which takes four words.
	assert!(
		action.split_whitespace().count() >= 4,
		"{label} states {action:?} as its step, which is too short to state an action"
	);
	Prose::Step
}
