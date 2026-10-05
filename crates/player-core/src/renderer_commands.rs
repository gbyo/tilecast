//! Bounded semantic renderer command correlation and startup clear policy.
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use player_types::bounded::ShortToken;
use tokio::sync::oneshot;

/// The existing native Player bound for clearing Website data.
pub const WEBSITE_DATA_CLEAR_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_PENDING: usize = 8;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SemanticRendererCommandResult {
    pub command_id: uuid::Uuid,
    pub success: bool,
    pub code: ShortToken,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum RendererCommandError {
    #[error("too many renderer commands are pending")]
    Busy,
    #[error("renderer command could not be sent")]
    NotConnected,
    #[error("renderer disconnected before answering")]
    Disconnected,
    #[error("renderer did not answer in time")]
    Timeout,
}

#[derive(Debug, Default)]
pub struct RendererCommandBroker {
    pending: Mutex<HashMap<uuid::Uuid, oneshot::Sender<SemanticRendererCommandResult>>>,
}

struct Registration<'a> {
    broker: &'a RendererCommandBroker,
    id: uuid::Uuid,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.broker.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.id);
    }
}

impl RendererCommandBroker {
    /// Ignore unrequested, repeated, expired, and canceled results.
    pub fn complete(&self, result: SemanticRendererCommandResult) {
        if let Some(sender) = self.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&result.command_id)
        {
            let _ = sender.send(result);
        }
    }

    pub fn renderer_disconnected(&self) {
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).clear();
    }

    /// The host queues the command while holding its renderer/activation lock.
    /// No transport value enters Core, and cancellation removes the registration.
    /// The host supplies a fresh ID. An ID already pending is refused.
    pub async fn request<F, Fut>(
        &self,
        id: uuid::Uuid,
        timeout: Duration,
        queue: F,
    ) -> Result<SemanticRendererCommandResult, RendererCommandError>
    where
        F: FnOnce(uuid::Uuid) -> Fut,
        Fut: Future<Output = bool>,
    {
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self.pending.lock().unwrap_or_else(|error| error.into_inner());
            pending.retain(|_, sender| !sender.is_closed());
            if pending.len() >= MAX_PENDING || pending.contains_key(&id) {
                return Err(RendererCommandError::Busy);
            }
            pending.insert(id, sender);
        }
        let _registration = Registration { broker: self, id };
        if !queue(id).await {
            return Err(RendererCommandError::NotConnected);
        }
        match tokio::time::timeout(timeout, receiver).await {
            Ok(Ok(result)) => Ok(result),
            Ok(Err(_)) => Err(RendererCommandError::Disconnected),
            Err(_) => Err(RendererCommandError::Timeout),
        }
    }
}

/// Once per native Player process, retrying only on subsequent readiness events.
/// Manual clears do not change this state. Only a successful answer completes it.
#[derive(Debug, Default, PartialEq, Eq)]
pub enum StartupWebsiteClear {
    #[default]
    Idle,
    InFlight,
    Done,
}

impl StartupWebsiteClear {
    pub fn begin(&mut self, available: bool, enabled: bool) -> bool {
        if available && enabled && *self == Self::Idle {
            *self = Self::InFlight;
            true
        } else {
            false
        }
    }

    pub fn finish(&mut self, success: bool) {
        *self = if success { Self::Done } else { Self::Idle };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    fn result(id: uuid::Uuid, success: bool) -> SemanticRendererCommandResult {
        SemanticRendererCommandResult { command_id: id, success, code: ShortToken::new("result").unwrap() }
    }

    #[tokio::test(start_paused = true)]
    async fn duplicate_host_ids_cannot_replace_a_pending_command() {
        let broker = Arc::new(RendererCommandBroker::default());
        let id = uuid::Uuid::from_u128(41);
        let (queued, ready) = oneshot::channel();
        let task = tokio::spawn({
            let broker = broker.clone();
            async move {
                broker
                    .request(id, WEBSITE_DATA_CLEAR_TIMEOUT, |queued_id| async move {
                        assert_eq!(queued_id, id);
                        queued.send(()).unwrap();
                        true
                    })
                    .await
            }
        });
        ready.await.unwrap();
        assert_eq!(
            broker.request(id, WEBSITE_DATA_CLEAR_TIMEOUT, |_| async { panic!("duplicate must not queue") }).await,
            Err(RendererCommandError::Busy)
        );
        broker.complete(result(id, true));
        assert_eq!(task.await.unwrap(), Ok(result(id, true)));
        assert!(broker.pending.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn results_are_correlated_bounded_and_disconnect_fails_pending_commands() {
        let broker = Arc::new(RendererCommandBroker::default());
        let mut tasks = Vec::new();
        for _ in 0..MAX_PENDING {
            let broker = broker.clone();
            tasks.push(tokio::spawn(async move {
                broker.request(uuid::Uuid::new_v4(), WEBSITE_DATA_CLEAR_TIMEOUT, |_| async { true }).await
            }));
        }
        tokio::task::yield_now().await;
        assert_eq!(
            broker
                .request(uuid::Uuid::new_v4(), WEBSITE_DATA_CLEAR_TIMEOUT, |_| async { panic!("must not queue") })
                .await,
            Err(RendererCommandError::Busy)
        );
        broker.complete(result(uuid::Uuid::new_v4(), true));
        let ids: Vec<_> = broker.pending.lock().unwrap().keys().copied().collect();
        broker.complete(result(ids[0], false));
        broker.complete(result(ids[1], true));
        broker.complete(result(ids[1], false));
        broker.renderer_disconnected();
        let mut successes = 0;
        let mut failures = 0;
        let mut disconnected = 0;
        for task in tasks {
            match task.await.unwrap() {
                Ok(answer) if answer.success => successes += 1,
                Ok(_) => failures += 1,
                Err(RendererCommandError::Disconnected) => disconnected += 1,
                other => panic!("unexpected {other:?}"),
            }
        }
        assert_eq!((successes, failures, disconnected), (1, 1, MAX_PENDING - 2));
        assert!(broker.pending.lock().unwrap().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn refusal_timeout_and_cancellation_remove_the_request() {
        let broker = Arc::new(RendererCommandBroker::default());
        assert_eq!(
            broker.request(uuid::Uuid::new_v4(), WEBSITE_DATA_CLEAR_TIMEOUT, |_| async { false }).await,
            Err(RendererCommandError::NotConnected)
        );
        assert!(broker.pending.lock().unwrap().is_empty());
        let task = tokio::spawn({
            let broker = broker.clone();
            async move { broker.request(uuid::Uuid::new_v4(), WEBSITE_DATA_CLEAR_TIMEOUT, |_| async { true }).await }
        });
        tokio::task::yield_now().await;
        let id = *broker.pending.lock().unwrap().keys().next().unwrap();
        tokio::time::advance(WEBSITE_DATA_CLEAR_TIMEOUT).await;
        assert_eq!(task.await.unwrap(), Err(RendererCommandError::Timeout));
        broker.complete(result(id, true));
        assert!(broker.pending.lock().unwrap().is_empty());
        let task = tokio::spawn({
            let broker = broker.clone();
            async move { broker.request(uuid::Uuid::new_v4(), WEBSITE_DATA_CLEAR_TIMEOUT, |_| async { true }).await }
        });
        tokio::task::yield_now().await;
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        assert!(broker.pending.lock().unwrap().is_empty());
    }

    #[test]
    fn startup_clear_waits_for_support_retries_failures_and_completes_once() {
        let mut state = StartupWebsiteClear::default();
        assert!(!state.begin(false, true));
        assert!(!state.begin(true, false));
        for _ in 0..3 {
            assert!(state.begin(true, true));
            assert!(!state.begin(true, true));
            state.finish(false);
        }
        assert!(state.begin(true, true));
        state.finish(true);
        assert!(!state.begin(true, true));
    }
}
