use std::{
	sync::{
		Arc, Weak,
		atomic::{AtomicU8, Ordering},
	},
	time::{Duration, Instant},
};

use anyhow::{Error, Result};
use tokio::sync::Notify;

#[derive(Debug, Clone, Copy)]
#[repr(u8)]
pub enum AbortReason {
	Unknown = 1,
	Timeout = 2,
	Signal  = 3,
	User    = 4,
}

impl TryFrom<u8> for AbortReason {
	type Error = ();

	fn try_from(value: u8) -> std::result::Result<Self, ()> {
		match value {
			0 => Err(()),
			2 => Ok(Self::Timeout),
			3 => Ok(Self::Signal),
			4 => Ok(Self::User),
			_ => Ok(Self::Unknown),
		}
	}
}

#[derive(Default)]
struct Flag {
	reason:   AtomicU8,
	notifier: Notify,
}

impl Flag {
	fn cause(&self) -> Option<AbortReason> {
		self.reason.load(Ordering::Relaxed).try_into().ok()
	}

	async fn wait(&self) -> AbortReason {
		if let Some(reason) = self.cause() {
			return reason;
		}
		let notifier = self.notifier.notified();
		if let Some(reason) = self.cause() {
			return reason;
		}
		notifier.await;
		self.cause().unwrap_or(AbortReason::Unknown)
	}

	fn abort(&self, reason: AbortReason) {
		let old = self.reason.swap(reason as u8, Ordering::SeqCst);
		if old == 0 {
			self.notifier.notify_waiters();
		}
	}
}

#[derive(Clone, Default)]
pub struct CancelToken {
	deadline: Option<Instant>,
	flag:     Option<Arc<Flag>>,
}

impl From<()> for CancelToken {
	fn from((): ()) -> Self {
		Self::default()
	}
}

impl CancelToken {
	#[must_use]
	pub fn new(timeout_ms: Option<u32>) -> Self {
		Self::with_timeout(timeout_ms.map(|ms| Duration::from_millis(u64::from(ms))))
	}

	#[must_use]
	pub fn with_timeout(timeout: Option<Duration>) -> Self {
		Self { deadline: timeout.map(|duration| Instant::now() + duration), flag: None }
	}

	pub fn heartbeat(&self) -> Result<()> {
		if let Some(flag) = &self.flag
			&& let Some(reason) = flag.cause()
		{
			return Err(Error::msg(format!("Aborted: {reason:?}")));
		}
		if let Some(deadline) = self.deadline
			&& deadline < Instant::now()
		{
			return Err(Error::msg("Aborted: Timeout"));
		}
		Ok(())
	}

	pub async fn wait(&self) -> AbortReason {
		if let Some(flag) = self.flag.as_ref().and_then(|flag| flag.cause()) {
			return flag;
		}

		let by_flag = async {
			let Some(flag) = self.flag.as_ref() else {
				return std::future::pending().await;
			};
			flag.wait().await
		};

		let by_timeout = async {
			let Some(deadline) = self.deadline else {
				return std::future::pending().await;
			};
			tokio::time::sleep_until(deadline.into()).await;
			AbortReason::Timeout
		};

		tokio::select! {
			reason = by_flag => reason,
			reason = by_timeout => reason,
		}
	}

	pub fn abort_token(&self) -> AbortToken {
		AbortToken(self.flag.as_ref().map(Arc::downgrade))
	}

	pub fn emplace_abort_token(&mut self) -> AbortToken {
		AbortToken(Some(Arc::downgrade(self.flag.get_or_insert_default())))
	}

	#[must_use]
	pub fn aborted(&self) -> bool {
		if let Some(flag) = &self.flag
			&& flag.cause().is_some()
		{
			return true;
		}
		if let Some(deadline) = self.deadline
			&& deadline < Instant::now()
		{
			return true;
		}
		false
	}

	/// Whether the timeout passed with no abort requested.
	///
	/// A token that is both aborted and past its timeout reports a
	/// cancellation here, as [`CancelToken::heartbeat`] does: work that stops
	/// on its timeout may keep what it found, work that was cancelled may not.
	#[must_use]
	pub fn timed_out(&self) -> bool {
		if self
			.flag
			.as_ref()
			.is_some_and(|flag| flag.cause().is_some())
		{
			return false;
		}
		self
			.deadline
			.is_some_and(|deadline| deadline < Instant::now())
	}
}

#[derive(Clone, Default)]
pub struct AbortToken(Option<Weak<Flag>>);

impl AbortToken {
	pub fn abort(&self, reason: AbortReason) {
		if let Some(flag) = &self.0
			&& let Some(flag) = flag.upgrade()
		{
			flag.abort(reason);
		}
	}
}

#[cfg(test)]
mod tests {
	use std::time::Duration;

	use super::{AbortReason, CancelToken};

	/// Past its timeout, a token reports the timeout only while no abort was
	/// requested: work stopped by a timeout keeps what it found, cancelled
	/// work does not.
	#[test]
	fn a_token_reports_a_timeout_only_past_its_deadline_and_never_once_aborted() {
		assert!(!CancelToken::new(None).timed_out(), "a token without a timeout timed out");
		assert!(
			!CancelToken::with_timeout(Some(Duration::from_mins(1))).timed_out(),
			"a token timed out before its deadline"
		);

		let passed = CancelToken::new(Some(0));
		std::thread::sleep(Duration::from_millis(1));
		assert!(passed.timed_out(), "a token past its deadline did not report the timeout");
		assert!(passed.heartbeat().is_err(), "a heartbeat past the deadline succeeded");

		for timeout_ms in [None, Some(0)] {
			let mut aborted = CancelToken::new(timeout_ms);
			aborted.emplace_abort_token().abort(AbortReason::Signal);
			std::thread::sleep(Duration::from_millis(1));
			assert!(
				!aborted.timed_out(),
				"an aborted token with timeout {timeout_ms:?} reported a timeout"
			);
			assert!(aborted.aborted(), "an aborted token with timeout {timeout_ms:?} is not aborted");
		}
	}
}
