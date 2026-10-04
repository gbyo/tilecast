//! Serialized semantic captures shared by preview and Watch Live.
use std::collections::HashMap;
use std::future::Future;
use std::sync::Mutex;
use std::time::Duration;

use tokio::sync::oneshot;

use crate::{CapturedFrame, RendererCaptureRequest};

pub const RENDERER_CAPTURE_TIMEOUT: Duration = Duration::from_secs(10);

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CaptureError {
    #[error("nothing_shown")]
    NothingShown,
    #[error("protected_state")]
    ProtectedState,
    #[error("renderer_not_ready")]
    RendererNotReady,
    #[error("renderer_timeout")]
    RendererTimeout,
    #[error("renderer_disconnected")]
    RendererDisconnected,
    #[error("renderer_unavailable")]
    RendererUnavailable,
    #[error("capture_out_of_bounds")]
    OutOfBounds,
    #[error("capture_invalid")]
    Invalid,
}

impl CaptureError {
    pub fn reason_code(self) -> &'static str {
        match self {
            Self::NothingShown => "nothing_shown",
            Self::ProtectedState => "protected_state",
            Self::RendererNotReady => "renderer_not_ready",
            Self::RendererTimeout => "renderer_timeout",
            Self::RendererDisconnected => "renderer_disconnected",
            Self::RendererUnavailable => "renderer_unavailable",
            Self::OutOfBounds => "capture_out_of_bounds",
            Self::Invalid => "capture_invalid",
        }
    }
}

/// The host maps its active presentation into these semantic states.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CaptureState {
    NothingShown,
    Setup,
    Pairing,
    SafeMode,
    Presentation,
}

impl CaptureState {
    pub fn check(self, safe_mode_source: bool) -> Result<(), CaptureError> {
        if self == Self::NothingShown {
            Err(CaptureError::NothingShown)
        } else if safe_mode_source || matches!(self, Self::Setup | Self::Pairing | Self::SafeMode) {
            Err(CaptureError::ProtectedState)
        } else {
            Ok(())
        }
    }
}

type Answer = Result<CapturedFrame, CaptureError>;
type DecodeAnswer = Box<dyn FnOnce(RendererCaptureRequest) -> Answer + Send>;

struct Pending {
    answer: oneshot::Sender<DecodeAnswer>,
}

impl std::fmt::Debug for Pending {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.debug_struct("Pending").field("closed", &self.answer.is_closed()).finish()
    }
}

/// One fair capture slot across all callers. Results never enter durable state.
#[derive(Debug, Default)]
pub struct CaptureBroker {
    slot: tokio::sync::Mutex<()>,
    pending: Mutex<HashMap<uuid::Uuid, Pending>>,
}

struct Registration<'a> {
    broker: &'a CaptureBroker,
    id: uuid::Uuid,
}

impl Drop for Registration<'_> {
    fn drop(&mut self) {
        self.broker.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&self.id);
    }
}

impl CaptureBroker {
    /// Decode transport data only for a pending request, using its original
    /// bounds. The callback belongs to the host; Core sees decoded bytes only.
    pub fn complete_with(
        &self,
        id: uuid::Uuid,
        decode: impl FnOnce(RendererCaptureRequest) -> Answer + Send + 'static,
    ) {
        let pending = self.pending.lock().unwrap_or_else(|error| error.into_inner()).remove(&id);
        if let Some(pending) = pending
            && !pending.answer.is_closed()
        {
            // Decode on the capture caller, not on the host's event-dispatch
            // task, which may hold an activation lock or deliver progress.
            let _ = pending.answer.send(Box::new(decode));
        }
    }

    /// The host checks its current presentation and queues the semantic request
    /// while holding its activation lock. A canceled or expired caller releases
    /// the slot and removes its pending request.
    pub async fn capture<F, Fut>(&self, max_width: u32, max_height: u32, max_bytes: u32, request: F) -> Answer
    where
        F: FnOnce(RendererCaptureRequest) -> Fut,
        Fut: Future<Output = Result<(), CaptureError>>,
    {
        let _slot = self.slot.lock().await;
        let id = uuid::Uuid::new_v4();
        let request_value = RendererCaptureRequest { request_id: id, max_width, max_height, max_bytes };
        let (sender, receiver) = oneshot::channel();
        self.pending.lock().unwrap_or_else(|error| error.into_inner()).insert(id, Pending { answer: sender });
        let _registration = Registration { broker: self, id };
        request(request_value).await?;
        match tokio::time::timeout(RENDERER_CAPTURE_TIMEOUT, receiver).await {
            Err(_) => Err(CaptureError::RendererTimeout),
            Ok(Err(_)) => Err(CaptureError::RendererDisconnected),
            Ok(Ok(decode)) => decode(request_value),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn protected_states_refuse_capture() {
        for state in [CaptureState::Setup, CaptureState::Pairing, CaptureState::SafeMode] {
            assert_eq!(state.check(false), Err(CaptureError::ProtectedState));
        }
        assert_eq!(CaptureState::Presentation.check(true), Err(CaptureError::ProtectedState));
        assert_eq!(CaptureState::NothingShown.check(false), Err(CaptureError::NothingShown));
        assert_eq!(CaptureState::Presentation.check(false), Ok(()));
    }

    #[tokio::test(start_paused = true)]
    async fn timeout_removes_pending_request_and_late_answers_are_ignored() {
        let broker = Arc::new(CaptureBroker::default());
        let (request_tx, request_rx) = oneshot::channel();
        let worker_broker = Arc::clone(&broker);
        let worker = tokio::spawn(async move {
            worker_broker
                .capture(640, 360, 4, |request| async move {
                    request_tx.send(request).unwrap();
                    Ok(())
                })
                .await
        });
        let request = request_rx.await.unwrap();
        tokio::time::advance(RENDERER_CAPTURE_TIMEOUT).await;
        assert_eq!(worker.await.unwrap(), Err(CaptureError::RendererTimeout));
        assert!(broker.pending.lock().unwrap().is_empty());
        broker.complete_with(request.request_id, |_| panic!("late answers must not be decoded"));
    }

    #[tokio::test]
    async fn captures_are_serialized_and_cancellation_releases_the_slot() {
        let broker = Arc::new(CaptureBroker::default());
        let (requests_tx, mut requests_rx) = tokio::sync::mpsc::channel(2);
        let first_broker = Arc::clone(&broker);
        let first_tx = requests_tx.clone();
        let first = tokio::spawn(async move {
            first_broker
                .capture(640, 360, 4, |request| async move {
                    first_tx.send(request).await.unwrap();
                    Ok(())
                })
                .await
        });
        let first_request = requests_rx.recv().await.unwrap();
        let second_broker = Arc::clone(&broker);
        let second = tokio::spawn(async move {
            second_broker
                .capture(320, 180, 4, |request| async move {
                    requests_tx.send(request).await.unwrap();
                    Ok(())
                })
                .await
        });
        tokio::task::yield_now().await;
        assert!(requests_rx.try_recv().is_err(), "second request waits for the fair slot");
        first.abort();
        assert!(first.await.unwrap_err().is_cancelled());
        let request = requests_rx.recv().await.unwrap();
        assert_ne!(request.request_id, first_request.request_id);
        broker.complete_with(first_request.request_id, |_| panic!("canceled request"));
        broker.complete_with(uuid::Uuid::new_v4(), |_| panic!("unrequested answer"));
        let decoded = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let callback_decoded = Arc::clone(&decoded);
        broker.complete_with(request.request_id, move |limits| {
            callback_decoded.store(true, std::sync::atomic::Ordering::SeqCst);
            assert_eq!((limits.max_width, limits.max_height, limits.max_bytes), (320, 180, 4));
            Ok(CapturedFrame::new(limits, vec![0xff, 0xd8, 0xff, 0xd9], 320, 180).unwrap())
        });
        assert!(!decoded.load(std::sync::atomic::Ordering::SeqCst), "event dispatch does not decode the frame");
        assert_eq!(second.await.unwrap().unwrap().dimensions(), (320, 180));
        assert!(decoded.load(std::sync::atomic::Ordering::SeqCst));
        assert!(broker.pending.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn refused_requests_release_the_registration_without_waiting() {
        let broker = CaptureBroker::default();
        assert_eq!(
            broker.capture(1, 1, 4, |_| async { Err(CaptureError::ProtectedState) }).await,
            Err(CaptureError::ProtectedState)
        );
        assert!(broker.pending.lock().unwrap().is_empty());
    }
}
