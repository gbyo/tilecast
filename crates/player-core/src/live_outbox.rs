//! The bounded Watch Live outbox between producers and the single-owner
//! Player WebSocket.
//!
//! JPEG frames are independent, so the outbox keeps only the newest one: a
//! newer frame replaces an unsent older frame. H.264 access units are not
//! independent: a P-frame decodes only after every frame since its IDR. The
//! outbox therefore queues them in order, within [`MAX_QUEUED_CHUNKS`] and
//! [`MAX_QUEUED_BYTES`], and never sends a delta whose predecessor it
//! dropped:
//!
//! - a full queue is cleared, the outbox waits for the next keyframe, and
//!   it asks the encoder for one;
//! - a keyframe supersedes queued deltas (they are unsent, and the IDR does
//!   not depend on them), which keeps latency down after a stall;
//! - a send that fails or times out loses a frame the server needed, so the
//!   socket owner reports it and the outbox waits for a keyframe again.
//!
//! The outbox holds memory only. Producers never touch the socket.

use std::collections::VecDeque;
use std::sync::Mutex;

use tokio::sync::{Notify, watch};

use crate::LiveFrame;

/// Largest number of unsent H.264 access units: two seconds at 15 FPS.
pub const MAX_QUEUED_CHUNKS: usize = 30;
/// Largest number of unsent H.264 bytes.
pub const MAX_QUEUED_BYTES: usize = 2 * 1024 * 1024;

/// One message for the socket owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutboxItem {
    /// A complete TCLS version 1 JPEG frame.
    Jpeg(LiveFrame),
    /// A complete TCLS version 2 H.264 message.
    Encoded { session_id: uuid::Uuid, packet: Vec<u8>, keyframe: bool },
}

impl OutboxItem {
    pub fn session_id(&self) -> uuid::Uuid {
        match self {
            Self::Jpeg(frame) => frame.session_id,
            Self::Encoded { session_id, .. } => *session_id,
        }
    }

    pub fn into_bytes(self) -> Vec<u8> {
        match self {
            Self::Jpeg(frame) => frame.frame,
            Self::Encoded { packet, .. } => packet,
        }
    }
}

/// What happened to an offered access unit.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Offer {
    Queued,
    /// A delta while the outbox waits for a keyframe: not decodable.
    AwaitingKeyframe,
    /// The queue was full: it was cleared and a keyframe is needed.
    Overflowed,
}

#[derive(Debug, Default)]
struct Encoded {
    session_id: uuid::Uuid,
    queue: VecDeque<(Vec<u8>, bool)>,
    bytes: usize,
    awaiting_keyframe: bool,
}

#[derive(Debug, Default)]
struct State {
    jpeg: Option<LiveFrame>,
    encoded: Option<Encoded>,
}

/// See the module documentation.
#[derive(Debug)]
pub struct LiveOutbox {
    state: Mutex<State>,
    ready: Notify,
    /// Bumped whenever the outbox needs a keyframe to resume.
    keyframe_requests: watch::Sender<u64>,
    /// Bumped on every overflow or transport loss (runtime downgrade input).
    resyncs: watch::Sender<u64>,
}

impl Default for LiveOutbox {
    fn default() -> Self {
        Self {
            state: Mutex::default(),
            ready: Notify::new(),
            keyframe_requests: watch::Sender::new(0),
            resyncs: watch::Sender::new(0),
        }
    }
}

impl LiveOutbox {
    fn lock(&self) -> std::sync::MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|error| error.into_inner())
    }

    fn need_keyframe(&self) {
        self.keyframe_requests.send_modify(|count| *count = count.wrapping_add(1));
        self.resyncs.send_modify(|count| *count = count.wrapping_add(1));
    }

    /// Replaces any unsent message with the newest JPEG. A message of
    /// another session is stale and goes too.
    pub fn offer_jpeg(&self, frame: LiveFrame) {
        let mut state = self.lock();
        if state.encoded.as_ref().is_some_and(|encoded| encoded.session_id != frame.session_id) {
            state.encoded = None;
        }
        state.jpeg = Some(frame);
        drop(state);
        self.ready.notify_waiters();
    }

    /// Queues one H.264 message for `session_id` in order. See [`Offer`].
    pub fn offer_encoded(&self, session_id: uuid::Uuid, packet: Vec<u8>, keyframe: bool) -> Offer {
        let mut state = self.lock();
        if state.jpeg.as_ref().is_some_and(|frame| frame.session_id != session_id) {
            state.jpeg = None;
        }
        let encoded = match &mut state.encoded {
            Some(encoded) if encoded.session_id == session_id => encoded,
            slot => slot.insert(Encoded { session_id, awaiting_keyframe: true, ..Encoded::default() }),
        };
        if keyframe {
            encoded.queue.clear();
            encoded.bytes = 0;
            encoded.awaiting_keyframe = false;
        } else if encoded.awaiting_keyframe {
            return Offer::AwaitingKeyframe;
        }
        if encoded.queue.len() + 1 > MAX_QUEUED_CHUNKS || encoded.bytes + packet.len() > MAX_QUEUED_BYTES {
            encoded.queue.clear();
            encoded.bytes = 0;
            encoded.awaiting_keyframe = true;
            drop(state);
            self.need_keyframe();
            return Offer::Overflowed;
        }
        encoded.bytes += packet.len();
        encoded.queue.push_back((packet, keyframe));
        drop(state);
        self.ready.notify_waiters();
        Offer::Queued
    }

    /// A message was taken but not delivered (send failure, timeout, socket
    /// loss). Everything queued after it depends on it, so it goes too.
    pub fn delivery_failed(&self, session_id: uuid::Uuid) {
        let mut state = self.lock();
        if let Some(encoded) = state.encoded.as_mut().filter(|encoded| encoded.session_id == session_id) {
            encoded.queue.clear();
            encoded.bytes = 0;
            encoded.awaiting_keyframe = true;
            drop(state);
            self.need_keyframe();
        }
    }

    /// Drops every unsent message of one session; a newer session's
    /// messages are untouched. An H.264 stream then waits for a keyframe.
    pub fn clear_session(&self, session_id: uuid::Uuid) {
        let mut state = self.lock();
        if state.jpeg.as_ref().is_some_and(|frame| frame.session_id == session_id) {
            state.jpeg = None;
        }
        if let Some(encoded) = state.encoded.as_mut().filter(|encoded| encoded.session_id == session_id) {
            encoded.queue.clear();
            encoded.bytes = 0;
            encoded.awaiting_keyframe = true;
        }
    }

    /// Drops everything (protected state, no server, session ended).
    pub fn clear(&self) {
        *self.lock() = State::default();
    }

    /// Takes the next message without waiting.
    pub fn try_take(&self) -> Option<OutboxItem> {
        let mut state = self.lock();
        if let Some(encoded) = state.encoded.as_mut()
            && let Some((packet, keyframe)) = encoded.queue.pop_front()
        {
            encoded.bytes -= packet.len();
            return Some(OutboxItem::Encoded { session_id: encoded.session_id, packet, keyframe });
        }
        state.jpeg.take().map(OutboxItem::Jpeg)
    }

    /// Waits for the next message. Cancel-safe: a message is removed only in
    /// the poll that returns it.
    pub async fn next(&self) -> OutboxItem {
        loop {
            let notified = self.ready.notified();
            tokio::pin!(notified);
            notified.as_mut().enable();
            if let Some(item) = self.try_take() {
                return item;
            }
            notified.await;
        }
    }

    /// Changes whenever the outbox needs a keyframe to resume.
    pub fn keyframe_requests(&self) -> watch::Receiver<u64> {
        self.keyframe_requests.subscribe()
    }

    /// Changes on every overflow or delivery failure.
    pub fn resyncs(&self) -> watch::Receiver<u64> {
        self.resyncs.subscribe()
    }

    /// Whether nothing waits for the socket.
    pub fn is_empty(&self) -> bool {
        let state = self.lock();
        state.jpeg.is_none() && state.encoded.as_ref().is_none_or(|encoded| encoded.queue.is_empty())
    }

    /// Unsent H.264 messages and bytes (tests and diagnostics).
    pub fn queued(&self) -> (usize, usize) {
        let state = self.lock();
        state.encoded.as_ref().map_or((0, 0), |encoded| (encoded.queue.len(), encoded.bytes))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const A: uuid::Uuid = uuid::Uuid::from_u128(1);
    const B: uuid::Uuid = uuid::Uuid::from_u128(2);

    fn take_all(outbox: &LiveOutbox) -> Vec<(Vec<u8>, bool)> {
        std::iter::from_fn(|| outbox.try_take())
            .map(|item| match item {
                OutboxItem::Encoded { packet, keyframe, .. } => (packet, keyframe),
                OutboxItem::Jpeg(frame) => (frame.frame, false),
            })
            .collect()
    }

    #[test]
    fn a_newer_jpeg_supersedes_an_unsent_older_one() {
        let outbox = LiveOutbox::default();
        outbox.offer_jpeg(LiveFrame { session_id: A, frame: vec![1] });
        outbox.offer_jpeg(LiveFrame { session_id: A, frame: vec![2] });
        assert_eq!(outbox.try_take(), Some(OutboxItem::Jpeg(LiveFrame { session_id: A, frame: vec![2] })));
        assert_eq!(outbox.try_take(), None);
    }

    #[test]
    fn encoded_messages_keep_their_order_and_never_start_with_a_delta() {
        let outbox = LiveOutbox::default();
        assert_eq!(outbox.offer_encoded(A, vec![0], false), Offer::AwaitingKeyframe);
        assert_eq!(outbox.offer_encoded(A, vec![1], true), Offer::Queued);
        assert_eq!(outbox.offer_encoded(A, vec![2], false), Offer::Queued);
        assert_eq!(outbox.offer_encoded(A, vec![3], false), Offer::Queued);
        assert_eq!(take_all(&outbox), vec![(vec![1], true), (vec![2], false), (vec![3], false)]);
    }

    #[test]
    fn overflow_clears_the_dependent_gop_and_resumes_at_a_keyframe() {
        let outbox = LiveOutbox::default();
        let mut requests = outbox.keyframe_requests();
        assert_eq!(outbox.offer_encoded(A, vec![0; 10], true), Offer::Queued);
        for _ in 1..MAX_QUEUED_CHUNKS {
            assert_eq!(outbox.offer_encoded(A, vec![1; 10], false), Offer::Queued);
        }
        assert_eq!(outbox.offer_encoded(A, vec![2; 10], false), Offer::Overflowed);
        assert!(requests.has_changed().unwrap(), "overflow asks the encoder for a keyframe");
        requests.mark_unchanged();
        assert_eq!(outbox.queued(), (0, 0), "the dependent GOP is gone");
        assert_eq!(outbox.offer_encoded(A, vec![3; 10], false), Offer::AwaitingKeyframe);
        assert_eq!(outbox.offer_encoded(A, vec![4; 10], true), Offer::Queued);
        assert_eq!(outbox.offer_encoded(A, vec![5; 10], false), Offer::Queued);
        assert_eq!(take_all(&outbox), vec![(vec![4; 10], true), (vec![5; 10], false)]);
        assert!(!requests.has_changed().unwrap());
    }

    #[test]
    fn the_byte_bound_holds_for_large_access_units() {
        let outbox = LiveOutbox::default();
        let big = MAX_QUEUED_BYTES / 4;
        assert_eq!(outbox.offer_encoded(A, vec![0; big], true), Offer::Queued);
        for _ in 0..3 {
            assert_eq!(outbox.offer_encoded(A, vec![0; big], false), Offer::Queued);
        }
        assert_eq!(outbox.offer_encoded(A, vec![0; 1], false), Offer::Overflowed);
        assert!(outbox.queued().1 <= MAX_QUEUED_BYTES);
    }

    #[test]
    fn a_keyframe_supersedes_unsent_deltas() {
        let outbox = LiveOutbox::default();
        outbox.offer_encoded(A, vec![1], true);
        outbox.offer_encoded(A, vec![2], false);
        outbox.offer_encoded(A, vec![3], true);
        assert_eq!(take_all(&outbox), vec![(vec![3], true)]);
    }

    #[test]
    fn a_failed_delivery_drops_dependents_until_the_next_keyframe() {
        let outbox = LiveOutbox::default();
        let resyncs = outbox.resyncs();
        outbox.offer_encoded(A, vec![1], true);
        outbox.offer_encoded(A, vec![2], false);
        outbox.offer_encoded(A, vec![3], false);
        let lost = outbox.try_take().unwrap();
        outbox.delivery_failed(lost.session_id());
        assert!(resyncs.has_changed().unwrap());
        assert_eq!(outbox.try_take(), None, "frames after the lost one depend on it");
        assert_eq!(outbox.offer_encoded(A, vec![4], false), Offer::AwaitingKeyframe);
        assert_eq!(outbox.offer_encoded(A, vec![5], true), Offer::Queued);
        assert_eq!(take_all(&outbox), vec![(vec![5], true)]);
    }

    #[test]
    fn sessions_never_mix_and_clearing_one_spares_a_newer_one() {
        let outbox = LiveOutbox::default();
        outbox.offer_encoded(A, vec![1], true);
        outbox.offer_encoded(B, vec![2], true);
        assert_eq!(take_all(&outbox), vec![(vec![2], true)], "a replaced session's chunks are stale");
        outbox.offer_encoded(B, vec![3], true);
        outbox.clear_session(A);
        assert_eq!(outbox.queued().0, 1);
        outbox.clear_session(B);
        assert_eq!(outbox.queued().0, 0);
        assert_eq!(outbox.offer_encoded(B, vec![4], false), Offer::AwaitingKeyframe);
        outbox.offer_jpeg(LiveFrame { session_id: A, frame: vec![5] });
        outbox.offer_encoded(B, vec![6], true);
        assert_eq!(take_all(&outbox), vec![(vec![6], true)], "the JPEG belonged to an older session");
    }

    #[tokio::test(start_paused = true)]
    async fn next_waits_for_a_message_and_is_cancel_safe() {
        let outbox = std::sync::Arc::new(LiveOutbox::default());
        let waiting = tokio::time::timeout(std::time::Duration::from_millis(10), outbox.next()).await;
        assert!(waiting.is_err(), "nothing to send");
        let worker = tokio::spawn({
            let outbox = std::sync::Arc::clone(&outbox);
            async move { outbox.next().await }
        });
        tokio::task::yield_now().await;
        outbox.offer_encoded(A, vec![7], true);
        assert_eq!(worker.await.unwrap(), OutboxItem::Encoded { session_id: A, packet: vec![7], keyframe: true });
        assert_eq!(outbox.try_take(), None);
    }
}
