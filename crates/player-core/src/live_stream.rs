//! Studio Watch Live: the native Players' ephemeral live stream.
//!
//! While Studio holds a live-stream lease, Core reconciles
//! `GET /api/v1/player/live-stream-session` (every 15 s idle, every 5 s
//! active, at once on the `live_stream.session_changed` push), naming the
//! profiles the host can produce now, and runs the profile the server
//! selected:
//!
//! - An MJPEG profile captures the visible output at the leased cadence
//!   through the shared [`crate::CaptureBroker`] and offers TCLS version 1
//!   frames to the [`LiveOutbox`], which keeps only the newest.
//! - An H.264 profile runs one persistent host encoder
//!   ([`LiveStreamHost::start_live_encoder`]) and offers TCLS version 2
//!   access units in order; see [`crate::live_outbox`] for the
//!   dependency-aware backpressure.
//!
//! A finished capture or access unit is re-checked before handoff: if the
//! session was replaced, expired, or degraded, or the screen entered a
//! protected state while the data was produced, it is discarded. A
//! protected state also stops the encoder until it ends. An encoder that
//! cannot sustain its profile degrades the session one level, once, for the
//! rest of the lease; a new lease probes the best profile again. Frames,
//! access units, and sessions are memory-only and never touch SQLite, the
//! content store, Activity, logs, or proof-of-play.

use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::time::{Duration, Instant};

use crate::watch_live::{DowngradeMonitor, EncodedChunkSink, EncoderConfig, LiveEncoder, SinkEvent, Sustainability};
use crate::{CaptureError, CapturedFrame, LiveOutbox, Offer};
use player_client::live_stream::{
    ChunkHeader, LiveStreamSession, MIN_CAPTURE_PAUSE_MILLIS, StreamMode, WatchLiveCapabilities, WatchLiveProfile,
};
use player_client::{AuthenticatedServer, ServerError};
use player_types::Timestamp;

/// Services required by Watch Live; the host owns capture, encoders,
/// renderer transport, and the socket.
#[async_trait::async_trait]
pub trait LiveStreamHost: Send + Sync {
    /// One bounded JPEG of the final output (MJPEG profiles).
    async fn capture_live_frame(
        &self,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError>;
    async fn presentation_protected(&self) -> bool;
    /// The profiles this host can produce now, from a real probe of its
    /// encoder environment, never from the platform name.
    fn watch_live_capabilities(&self) -> WatchLiveCapabilities {
        WatchLiveCapabilities::legacy()
    }
    /// Starts a persistent encoder of the final output for one H.264
    /// profile. The host captures only while the returned handle lives and
    /// pushes access units into `sink`.
    async fn start_live_encoder(
        &self,
        _config: EncoderConfig,
        _sink: EncodedChunkSink,
    ) -> Result<Box<dyn LiveEncoder>, CaptureError> {
        Err(CaptureError::RendererUnavailable)
    }
    fn now(&self) -> Timestamp;
    fn live_outbox(&self) -> &LiveOutbox;
}

/// A session this Player degraded out of `profile`: the server must select
/// a lower profile for that session only.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Degradation {
    pub session_id: uuid::Uuid,
    pub profile: WatchLiveProfile,
}

#[async_trait::async_trait]
pub trait LiveStreamApi: Send + Sync {
    async fn live_stream_session(
        &self,
        capabilities: &WatchLiveCapabilities,
        degraded: Option<Degradation>,
    ) -> Result<LiveStreamSession, ServerError>;
}

#[async_trait::async_trait]
impl LiveStreamApi for AuthenticatedServer {
    async fn live_stream_session(
        &self,
        capabilities: &WatchLiveCapabilities,
        degraded: Option<Degradation>,
    ) -> Result<LiveStreamSession, ServerError> {
        AuthenticatedServer::live_stream_session(self, capabilities, degraded.map(|d| (d.session_id, d.profile))).await
    }
}

const IDLE_RECONCILE: Duration = Duration::from_secs(15);
const ACTIVE_RECONCILE: Duration = Duration::from_secs(5);
/// How often the encoded stream re-checks its session, protected state, and
/// sustainability between access units.
const ENCODED_TICK: Duration = Duration::from_millis(250);

/// One TCLS-encoded Watch Live JPEG frame for the WebSocket owner.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LiveFrame {
    pub session_id: uuid::Uuid,
    /// The complete TCLS version 1 message: 33-byte header plus JPEG.
    pub frame: Vec<u8>,
}

/// Delay before the next capture: the monotonic capture time counts toward
/// the target interval, floored so a zero elapsed time cannot busy-loop.
fn capture_delay(interval: Duration, elapsed: Duration) -> Duration {
    interval.saturating_sub(elapsed).max(Duration::from_millis(MIN_CAPTURE_PAUSE_MILLIS))
}

/// The identity of what a worker produces. A new session, a profile change,
/// or a degradation (a new generation) restarts the worker.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct StreamKey {
    id: uuid::Uuid,
    mode: StreamMode,
    generation: u64,
}

fn stream_key(session: &LiveStreamSession) -> Option<StreamKey> {
    Some(StreamKey { id: session.id?, mode: session.mode(), generation: session.profile_generation })
}

/// Whether a finished capture may be handed to the WebSocket owner: the same
/// session is still active in the same mode, so data from a replaced,
/// expired, or degraded session is never sent merely because its capture
/// started in an allowed state.
fn should_send(key: StreamKey, current: Option<&LiveStreamSession>, now_unix_millis: i64) -> bool {
    current.is_some_and(|session| stream_key(session) == Some(key) && session.is_active_at(now_unix_millis))
}

async fn capture_loop<H: LiveStreamHost>(
    host: Arc<H>,
    current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>>,
    key: StreamKey,
    shutdown: tokio_util::sync::CancellationToken,
) -> WorkerExit {
    let StreamMode::Mjpeg { frame_interval_millis, max_width, max_height, max_frame_bytes } = key.mode else {
        return WorkerExit::Finished;
    };
    let id = key.id;
    loop {
        let snapshot = current.lock().await.clone();
        if !should_send(key, snapshot.as_ref(), host.now().unix_millis()) {
            host.live_outbox().clear_session(id);
            return WorkerExit::Finished;
        }
        let interval = Duration::from_millis(frame_interval_millis);
        let started = Instant::now();
        match host.capture_live_frame(max_width, max_height, max_frame_bytes as u32).await {
            Ok(captured) => {
                let (width, height) = captured.dimensions();
                let jpeg = captured.into_jpeg();
                let fresh = current.lock().await.clone();
                let now = host.now().unix_millis();
                if should_send(key, fresh.as_ref(), now) {
                    if host.presentation_protected().await {
                        host.live_outbox().clear_session(id);
                    } else if player_client::live_stream::is_complete_jpeg(&jpeg)
                        && let Some(frame) =
                            player_client::live_stream::encode_live_stream_frame(&id, now, width, height, &jpeg)
                    {
                        host.live_outbox().offer_jpeg(LiveFrame { session_id: id, frame });
                    }
                }
            }
            Err(error) => {
                let reason = error.reason_code();
                if error == CaptureError::ProtectedState {
                    host.live_outbox().clear_session(id);
                }
                tracing::debug!(component = "live_stream", event = "capture_dropped", reason);
            }
        }
        let delay = capture_delay(interval, started.elapsed());
        tokio::select! {
            () = shutdown.cancelled() => return WorkerExit::Finished,
            () = tokio::time::sleep(delay) => {}
        }
    }
}

/// Sequence and timestamp continuity of one session's H.264 stream across
/// encoder restarts (a protected pause or a worker restart). Sequence
/// numbers and timestamps never repeat or go backwards within a session.
#[derive(Debug)]
struct StreamClock {
    session_id: uuid::Uuid,
    sequence: Arc<AtomicU64>,
    last_timestamp_micros: std::sync::Mutex<u64>,
}

impl StreamClock {
    fn new(session_id: uuid::Uuid) -> Arc<Self> {
        Arc::new(Self {
            session_id,
            sequence: Arc::new(AtomicU64::new(1)),
            last_timestamp_micros: std::sync::Mutex::new(0),
        })
    }

    /// The timestamp base for a new encoder: one frame after the last one.
    fn restart_base(&self, interval: Duration) -> u64 {
        let last = *self.last_timestamp_micros.lock().unwrap_or_else(|error| error.into_inner());
        if last == 0 { 0 } else { last + interval.as_micros() as u64 }
    }

    fn stamp(&self, base: u64, encoder_micros: u64) -> u64 {
        let mut last = self.last_timestamp_micros.lock().unwrap_or_else(|error| error.into_inner());
        *last = (*last).max(base.saturating_add(encoder_micros));
        *last
    }
}

/// How a worker ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum WorkerExit {
    /// Shutdown, session over, replaced, or changed.
    Finished,
    /// The profile cannot be sustained (or started): degrade this session.
    Degrade(WatchLiveProfile, &'static str),
}

/// Why the inner encoded loop stopped its encoder.
enum EncoderStop {
    Exit(WorkerExit),
    Protected,
}

async fn encoded_loop<H: LiveStreamHost>(
    host: Arc<H>,
    current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>>,
    key: StreamKey,
    clock: Arc<StreamClock>,
    shutdown: tokio_util::sync::CancellationToken,
) -> WorkerExit {
    let StreamMode::H264(profile) = key.mode else { return WorkerExit::Finished };
    if !host.watch_live_capabilities().contains(profile) {
        // The server selected a profile this host no longer offers.
        return WorkerExit::Degrade(profile, "profile_unavailable");
    }
    let config = EncoderConfig::for_profile(profile);
    loop {
        // Never start an encoder (and so never capture) in a protected state.
        loop {
            if !should_send(key, current.lock().await.as_ref(), host.now().unix_millis()) {
                host.live_outbox().clear_session(key.id);
                return WorkerExit::Finished;
            }
            if !host.presentation_protected().await {
                break;
            }
            host.live_outbox().clear_session(key.id);
            tokio::select! {
                () = shutdown.cancelled() => return WorkerExit::Finished,
                () = tokio::time::sleep(ENCODED_TICK) => {}
            }
        }
        match run_encoder(&host, &current, key, config, &clock, &shutdown).await {
            EncoderStop::Exit(exit) => {
                host.live_outbox().clear_session(key.id);
                return exit;
            }
            EncoderStop::Protected => {
                host.live_outbox().clear_session(key.id);
                tracing::debug!(component = "live_stream", event = "encoder_paused", reason = "protected_state");
            }
        }
    }
}

/// Runs one host encoder until the session ends, the screen becomes
/// protected, or the profile proves unsustainable. Dropping `encoder` on
/// return stops and frees it.
async fn run_encoder<H: LiveStreamHost>(
    host: &Arc<H>,
    current: &Arc<tokio::sync::Mutex<Option<LiveStreamSession>>>,
    key: StreamKey,
    config: EncoderConfig,
    clock: &StreamClock,
    shutdown: &tokio_util::sync::CancellationToken,
) -> EncoderStop {
    let profile = config.profile;
    let outbox = host.live_outbox();
    let mut keyframe_requests = outbox.keyframe_requests();
    let mut resyncs = outbox.resyncs();
    keyframe_requests.mark_unchanged();
    resyncs.mark_unchanged();
    let (sink, mut events) = EncodedChunkSink::new(Arc::clone(&clock.sequence));
    let encoder: Box<dyn LiveEncoder> = match host.start_live_encoder(config, sink.clone()).await {
        Ok(encoder) => encoder,
        Err(error) => {
            tracing::info!(component = "live_stream", event = "encoder_start_failed", reason = error.reason_code());
            return EncoderStop::Exit(WorkerExit::Degrade(profile, "encoder_start"));
        }
    };
    let base = clock.restart_base(config.frame_interval());
    let mut monitor = DowngradeMonitor::new(profile);
    let mut awaiting_keyframe = true;
    let mut tick = tokio::time::interval(ENCODED_TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_tick = Instant::now();
    loop {
        tokio::select! {
            () = shutdown.cancelled() => return EncoderStop::Exit(WorkerExit::Finished),
            changed = keyframe_requests.changed() => {
                if changed.is_ok() {
                    encoder.request_keyframe();
                }
            }
            changed = resyncs.changed() => {
                if changed.is_ok() {
                    monitor.resync();
                }
            }
            _ = tick.tick() => {
                if !should_send(key, current.lock().await.as_ref(), host.now().unix_millis()) {
                    return EncoderStop::Exit(WorkerExit::Finished);
                }
                if host.presentation_protected().await {
                    return EncoderStop::Protected;
                }
                if sink.take_keyframe_request() {
                    encoder.request_keyframe();
                }
                let now = Instant::now();
                let verdict = monitor.tick(now - last_tick);
                last_tick = now;
                match verdict {
                    Sustainability::Degrade(reason) => {
                        tracing::info!(component = "live_stream", event = "profile_unsustainable", profile = profile.id(), reason);
                        return EncoderStop::Exit(WorkerExit::Degrade(profile, reason));
                    }
                    Sustainability::Unsustainable(reason) => {
                        tracing::debug!(component = "live_stream", event = "profile_window_unsustainable", profile = profile.id(), reason);
                    }
                    Sustainability::Measuring | Sustainability::Sustainable => {}
                }
            }
            event = events.recv() => match event {
                None => return EncoderStop::Exit(WorkerExit::Degrade(profile, "encoder_stopped")),
                Some(SinkEvent::Failed(reason)) => {
                    tracing::info!(component = "live_stream", event = "encoder_failed", profile = profile.id(), reason);
                    return EncoderStop::Exit(WorkerExit::Degrade(profile, "encoder_failed"));
                }
                Some(SinkEvent::Sample(sample)) => monitor.sample(sample),
                Some(SinkEvent::Chunk { sequence, chunk }) => {
                    // Re-check the session and privacy before the access
                    // unit leaves the encoder's hands.
                    if !should_send(key, current.lock().await.as_ref(), host.now().unix_millis()) {
                        return EncoderStop::Exit(WorkerExit::Finished);
                    }
                    if host.presentation_protected().await {
                        return EncoderStop::Protected;
                    }
                    if awaiting_keyframe && !chunk.keyframe {
                        continue;
                    }
                    let header = ChunkHeader {
                        session_id: key.id,
                        profile,
                        sequence,
                        timestamp_micros: clock.stamp(base, chunk.timestamp_micros),
                        width: chunk.width,
                        height: chunk.height,
                        keyframe: chunk.keyframe,
                    };
                    let Some(packet) = player_client::live_stream::encode_live_stream_chunk(&header, &chunk.data)
                    else {
                        // A malformed unit breaks the chain: drop dependents.
                        tracing::debug!(component = "live_stream", event = "access_unit_invalid", profile = profile.id());
                        awaiting_keyframe = true;
                        encoder.request_keyframe();
                        continue;
                    };
                    monitor.chunk();
                    match outbox.offer_encoded(key.id, packet, chunk.keyframe) {
                        Offer::Queued => awaiting_keyframe = false,
                        Offer::AwaitingKeyframe => {
                            awaiting_keyframe = true;
                            encoder.request_keyframe();
                        }
                        // The outbox already asked for a keyframe and counted a resync.
                        Offer::Overflowed => awaiting_keyframe = true,
                    }
                }
            },
        }
    }
}

/// What a reconciled session means for the worker: an inactive, expired, or
/// incomplete lease stops it; an unchanged session (same ID, mode, and
/// generation) only refreshes expiry; anything else restarts it.
#[derive(Debug, PartialEq, Eq)]
enum ReconcileAction {
    Keep,
    Restart,
    Stop,
}

fn reconcile_action(
    existing: Option<&LiveStreamSession>,
    next: &LiveStreamSession,
    now_unix_millis: i64,
    worker_running: bool,
) -> ReconcileAction {
    if !next.is_active_at(now_unix_millis) {
        return ReconcileAction::Stop;
    }
    match existing {
        Some(session) if stream_key(session) == stream_key(next) && worker_running => ReconcileAction::Keep,
        _ => ReconcileAction::Restart,
    }
}

/// The capability list and degradation hint for the next session GET.
fn advertised(host_capabilities: WatchLiveCapabilities, degraded: Option<Degradation>) -> WatchLiveCapabilities {
    match degraded {
        Some(degradation) => host_capabilities.below(degradation.profile),
        None => host_capabilities,
    }
}

/// Whether `session` asks for an H.264 profile this session already
/// degraded out of (or a better one).
fn refused_after_degradation(session: &LiveStreamSession, degraded: Option<Degradation>) -> bool {
    match (session.mode(), degraded) {
        (StreamMode::H264(profile), Some(degradation)) => {
            Some(degradation.session_id) == session.id && profile <= degradation.profile
        }
        _ => false,
    }
}

struct Worker {
    handle: tokio::task::JoinHandle<WorkerExit>,
}

/// Stops the worker and waits until its task (and so any encoder handle it
/// owns) is dropped, so an old encoder never outlives its session or
/// overlaps the next one.
async fn stop_worker(worker: &mut Option<Worker>) {
    if let Some(mut stopped) = worker.take() {
        stopped.handle.abort();
        let _ = (&mut stopped.handle).await;
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.handle.abort();
    }
}

pub async fn drive_live_stream<H, A>(
    host: Arc<H>,
    mut server: tokio::sync::watch::Receiver<Option<A>>,
    wake: &tokio::sync::Notify,
    shutdown: &tokio_util::sync::CancellationToken,
) where
    H: LiveStreamHost + 'static,
    A: LiveStreamApi + Clone,
{
    let current: Arc<tokio::sync::Mutex<Option<LiveStreamSession>>> = Arc::new(tokio::sync::Mutex::new(None));
    let mut worker: Option<Worker> = None;
    let mut degraded: Option<Degradation> = None;
    let mut clock: Option<Arc<StreamClock>> = None;

    loop {
        // Reconcile before sleeping. This guarantees an immediate first poll
        // once an authenticated server handle exists, and every wake leads to
        // a fresh authoritative GET.
        let api = { server.borrow().clone() };
        let delay = match api {
            None => {
                stop_worker(&mut worker).await;
                *current.lock().await = None;
                host.live_outbox().clear();
                IDLE_RECONCILE
            }
            Some(api) => {
                let capabilities = advertised(host.watch_live_capabilities(), degraded);
                match api.live_stream_session(&capabilities, degraded).await {
                    Err(error) => {
                        tracing::debug!(
                            component = "live_stream",
                            event = "reconcile_failed",
                            reason = error.reason_code()
                        );
                        if current
                            .lock()
                            .await
                            .as_ref()
                            .is_some_and(|session| session.is_active_at(host.now().unix_millis()))
                        {
                            ACTIVE_RECONCILE
                        } else {
                            IDLE_RECONCILE
                        }
                    }
                    Ok(session) => {
                        if degraded.is_some_and(|degradation| Some(degradation.session_id) != session.id) {
                            // A new lease probes the best profile again.
                            degraded = None;
                        }
                        let running = worker.as_ref().is_some_and(|worker| !worker.handle.is_finished());
                        // Snapshot without holding the guard: the arms below
                        // relock `current`.
                        let existing = current.lock().await.clone();
                        match reconcile_action(existing.as_ref(), &session, host.now().unix_millis(), running) {
                            ReconcileAction::Stop => {
                                stop_worker(&mut worker).await;
                                *current.lock().await = None;
                                host.live_outbox().clear();
                                IDLE_RECONCILE
                            }
                            ReconcileAction::Keep => {
                                *current.lock().await = Some(session);
                                ACTIVE_RECONCILE
                            }
                            ReconcileAction::Restart if refused_after_degradation(&session, degraded) => {
                                // A server that still selects a profile this
                                // session degraded out of gets nothing.
                                stop_worker(&mut worker).await;
                                *current.lock().await = None;
                                host.live_outbox().clear();
                                ACTIVE_RECONCILE
                            }
                            ReconcileAction::Restart => {
                                // Stop (and free) the old worker's encoder
                                // before the new one starts.
                                stop_worker(&mut worker).await;
                                *current.lock().await = Some(session.clone());
                                let key = stream_key(&session).expect("an active session has an ID");
                                if clock.as_ref().is_none_or(|clock| clock.session_id != key.id) {
                                    clock = Some(StreamClock::new(key.id));
                                }
                                let worker_host = Arc::clone(&host);
                                let worker_shutdown = shutdown.clone();
                                let worker_current = Arc::clone(&current);
                                let worker_clock = Arc::clone(clock.as_ref().expect("set above"));
                                worker = Some(Worker {
                                    handle: tokio::spawn(async move {
                                        match key.mode {
                                            StreamMode::Mjpeg { .. } => {
                                                capture_loop(worker_host, worker_current, key, worker_shutdown).await
                                            }
                                            StreamMode::H264(_) => {
                                                encoded_loop(
                                                    worker_host,
                                                    worker_current,
                                                    key,
                                                    worker_clock,
                                                    worker_shutdown,
                                                )
                                                .await
                                            }
                                        }
                                    }),
                                });
                                ACTIVE_RECONCILE
                            }
                        }
                    }
                }
            }
        };

        tokio::select! {
            () = shutdown.cancelled() => return,
            () = tokio::time::sleep(delay) => {}
            changed = server.changed() => if changed.is_err() {
                return;
            },
            () = wake.notified() => {}
            exit = async {
                match worker.as_mut() {
                    Some(worker) => (&mut worker.handle).await,
                    None => std::future::pending().await,
                }
            } => {
                worker = None;
                if let Ok(WorkerExit::Degrade(profile, reason)) = exit
                    && let Some(id) = current.lock().await.as_ref().and_then(|session| session.id)
                {
                    // Degrade this session one level, once: the next GET
                    // tells the server, which selects a lower profile.
                    tracing::info!(component = "live_stream", event = "profile_degraded", profile = profile.id(), reason);
                    let worst = degraded.filter(|d| d.session_id == id).map_or(profile, |d| d.profile.max(profile));
                    degraded = Some(Degradation { session_id: id, profile: worst });
                } else {
                    // A worker that ended on its own (lease over, replaced)
                    // is reconciled soon, never in a tight loop.
                    tokio::select! {
                        () = shutdown.cancelled() => return,
                        () = tokio::time::sleep(Duration::from_secs(1)) => {}
                        () = wake.notified() => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{EncodedVideoChunk, OutboxItem, RendererCaptureRequest};
    use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering};

    const ID: &str = "bffef4b1-f9b5-4b25-9d4f-864fba88d86d";
    const OTHER: &str = "0f6b2f0e-1111-4c55-9a53-27f2f0b2f0aa";
    const KEY: [u8; 22] =
        [0, 0, 0, 1, 0x67, 0x42, 0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84];
    const DELTA: [u8; 6] = [0, 0, 1, 0x41, 0x88, 0xa0];

    struct Ticket {
        request: RendererCaptureRequest,
        answer: tokio::sync::oneshot::Sender<Result<CapturedFrame, CaptureError>>,
    }

    struct FakeEncoder {
        dropped: Arc<AtomicBool>,
        keyframes: Arc<AtomicU32>,
    }

    impl LiveEncoder for FakeEncoder {
        fn request_keyframe(&self) {
            self.keyframes.fetch_add(1, Ordering::SeqCst);
        }
    }

    impl Drop for FakeEncoder {
        fn drop(&mut self) {
            self.dropped.store(true, Ordering::SeqCst);
        }
    }

    struct Started {
        config: EncoderConfig,
        sink: EncodedChunkSink,
        dropped: Arc<AtomicBool>,
        keyframes: Arc<AtomicU32>,
    }

    struct Host {
        requests: tokio::sync::mpsc::Sender<Ticket>,
        outbox: LiveOutbox,
        clock: AtomicI64,
        protected: AtomicBool,
        capabilities: std::sync::Mutex<WatchLiveCapabilities>,
        encoders: tokio::sync::mpsc::UnboundedSender<Started>,
        live_encoders: Arc<AtomicU32>,
        fail_start: AtomicBool,
    }

    #[async_trait::async_trait]
    impl LiveStreamHost for Host {
        async fn capture_live_frame(
            &self,
            max_width: u32,
            max_height: u32,
            max_bytes: u32,
        ) -> Result<CapturedFrame, CaptureError> {
            let request = RendererCaptureRequest { request_id: uuid::Uuid::new_v4(), max_width, max_height, max_bytes };
            let (answer, receiver) = tokio::sync::oneshot::channel();
            self.requests.send(Ticket { request, answer }).await.map_err(|_| CaptureError::RendererDisconnected)?;
            receiver.await.map_err(|_| CaptureError::RendererDisconnected)?
        }
        async fn presentation_protected(&self) -> bool {
            self.protected.load(Ordering::SeqCst)
        }
        fn watch_live_capabilities(&self) -> WatchLiveCapabilities {
            self.capabilities.lock().unwrap().clone()
        }
        async fn start_live_encoder(
            &self,
            config: EncoderConfig,
            sink: EncodedChunkSink,
        ) -> Result<Box<dyn LiveEncoder>, CaptureError> {
            if self.fail_start.load(Ordering::SeqCst) {
                return Err(CaptureError::RendererUnavailable);
            }
            // At most one encoder may exist at a time.
            assert_eq!(self.live_encoders.fetch_add(1, Ordering::SeqCst), 0, "two encoders overlapped");
            let dropped = Arc::new(AtomicBool::new(false));
            let keyframes = Arc::new(AtomicU32::new(0));
            let _ = self.encoders.send(Started {
                config,
                sink,
                dropped: Arc::clone(&dropped),
                keyframes: Arc::clone(&keyframes),
            });
            struct Counted(FakeEncoder, Arc<AtomicU32>);
            impl LiveEncoder for Counted {
                fn request_keyframe(&self) {
                    self.0.request_keyframe();
                }
            }
            impl Drop for Counted {
                fn drop(&mut self) {
                    self.1.fetch_sub(1, Ordering::SeqCst);
                }
            }
            Ok(Box::new(Counted(FakeEncoder { dropped, keyframes }, Arc::clone(&self.live_encoders))))
        }
        fn now(&self) -> Timestamp {
            Timestamp::from_unix_millis(self.clock.load(Ordering::SeqCst)).unwrap()
        }
        fn live_outbox(&self) -> &LiveOutbox {
            &self.outbox
        }
    }

    fn host(
        now: i64,
    ) -> (Arc<Host>, tokio::sync::mpsc::Receiver<Ticket>, tokio::sync::mpsc::UnboundedReceiver<Started>) {
        let (requests, receiver) = tokio::sync::mpsc::channel(2);
        let (encoders, started) = tokio::sync::mpsc::unbounded_channel();
        (
            Arc::new(Host {
                requests,
                outbox: LiveOutbox::default(),
                clock: AtomicI64::new(now),
                protected: AtomicBool::new(false),
                capabilities: std::sync::Mutex::new(WatchLiveCapabilities::new(WatchLiveProfile::ALL)),
                encoders,
                live_encoders: Arc::new(AtomicU32::new(0)),
                fail_start: AtomicBool::new(false),
            }),
            receiver,
            started,
        )
    }

    fn answer(ticket: Ticket) {
        let request = ticket.request;
        assert_eq!((request.max_width, request.max_height, request.max_bytes), (640, 360, 102_400));
        let frame = CapturedFrame::new(request, vec![0xff, 0xd8, 0xff, 0xd9], 640, 360).unwrap();
        let _ = ticket.answer.send(Ok(frame));
    }

    fn session(id: &str, active: bool) -> LiveStreamSession {
        LiveStreamSession {
            id: Some(id.parse().unwrap()),
            active,
            expires_at: Some("2026-07-30T12:00:15Z".to_owned()),
            frame_interval_millis: 125,
            max_width: 640,
            max_height: 360,
            max_frame_bytes: 102_400,
            profile: None,
            profile_generation: 0,
        }
    }

    fn h264(id: &str, profile: WatchLiveProfile, generation: u64) -> LiveStreamSession {
        LiveStreamSession { profile: Some(profile), profile_generation: generation, ..session(id, true) }
    }

    fn expiry() -> i64 {
        Timestamp::parse("2026-07-30T12:00:15Z").unwrap().unix_millis()
    }

    fn mjpeg_key(lease: &LiveStreamSession) -> StreamKey {
        stream_key(lease).unwrap()
    }

    #[tokio::test(start_paused = true)]
    async fn protection_entered_during_capture_discards_the_image_and_queued_frame() {
        let lease = session(ID, true);
        let (host, mut requests, _) = host(expiry() - 1_000);
        host.outbox.offer_jpeg(LiveFrame { session_id: lease.id.unwrap(), frame: vec![1] });
        let key = mjpeg_key(&lease);
        let current = Arc::new(tokio::sync::Mutex::new(Some(lease)));
        let worker =
            tokio::spawn(capture_loop(Arc::clone(&host), current, key, tokio_util::sync::CancellationToken::new()));
        let ticket = requests.recv().await.unwrap();
        host.protected.store(true, Ordering::SeqCst);
        answer(ticket);
        let _next_capture = requests.recv().await.unwrap();
        assert!(host.outbox.try_take().is_none(), "protected capture cannot expose or retain an image");
        worker.abort();
        assert!(worker.await.unwrap_err().is_cancelled());
    }

    #[tokio::test]
    async fn replaced_lease_discards_old_capture_without_clearing_a_newer_frame() {
        let lease = session(ID, true);
        let (host, mut requests, _) = host(expiry() - 1_000);
        let key = mjpeg_key(&lease);
        let current = Arc::new(tokio::sync::Mutex::new(Some(lease)));
        let worker = tokio::spawn(capture_loop(
            Arc::clone(&host),
            Arc::clone(&current),
            key,
            tokio_util::sync::CancellationToken::new(),
        ));
        let ticket = requests.recv().await.unwrap();
        let replacement = session(OTHER, true);
        let frame = LiveFrame { session_id: replacement.id.unwrap(), frame: vec![2] };
        *current.lock().await = Some(replacement);
        host.outbox.offer_jpeg(frame.clone());
        answer(ticket);
        assert_eq!(worker.await.unwrap(), WorkerExit::Finished);
        assert_eq!(host.outbox.try_take(), Some(OutboxItem::Jpeg(frame)));
    }

    #[tokio::test(start_paused = true)]
    async fn expired_lease_discards_capture_and_clears_its_pending_frame() {
        let lease = session(ID, true);
        let (host, mut requests, _) = host(expiry() - 1_000);
        host.outbox.offer_jpeg(LiveFrame { session_id: lease.id.unwrap(), frame: vec![1] });
        let key = mjpeg_key(&lease);
        let current = Arc::new(tokio::sync::Mutex::new(Some(lease)));
        let worker =
            tokio::spawn(capture_loop(Arc::clone(&host), current, key, tokio_util::sync::CancellationToken::new()));
        let ticket = requests.recv().await.unwrap();
        host.clock.store(expiry(), Ordering::SeqCst);
        answer(ticket);
        worker.await.unwrap();
        assert!(host.outbox.try_take().is_none());
    }

    #[derive(Clone)]
    struct Api {
        session: Arc<std::sync::Mutex<LiveStreamSession>>,
        fetched: tokio::sync::mpsc::UnboundedSender<(WatchLiveCapabilities, Option<Degradation>)>,
    }

    #[async_trait::async_trait]
    impl LiveStreamApi for Api {
        async fn live_stream_session(
            &self,
            capabilities: &WatchLiveCapabilities,
            degraded: Option<Degradation>,
        ) -> Result<LiveStreamSession, ServerError> {
            let session = self.session.lock().unwrap().clone();
            self.fetched.send((capabilities.clone(), degraded)).unwrap();
            Ok(session)
        }
    }

    struct Driver {
        session: Arc<std::sync::Mutex<LiveStreamSession>>,
        fetches: tokio::sync::mpsc::UnboundedReceiver<(WatchLiveCapabilities, Option<Degradation>)>,
        wake: Arc<tokio::sync::Notify>,
        shutdown: tokio_util::sync::CancellationToken,
        worker: tokio::task::JoinHandle<()>,
        _server: tokio::sync::watch::Sender<Option<Api>>,
    }

    impl Driver {
        fn start(host: &Arc<Host>, initial: LiveStreamSession) -> Self {
            let (fetched, fetches) = tokio::sync::mpsc::unbounded_channel();
            let session = Arc::new(std::sync::Mutex::new(initial));
            let api = Api { session: Arc::clone(&session), fetched };
            let (server, receiver) = tokio::sync::watch::channel(Some(api));
            let wake = Arc::new(tokio::sync::Notify::new());
            let shutdown = tokio_util::sync::CancellationToken::new();
            let (worker_host, worker_wake, worker_shutdown) = (Arc::clone(host), Arc::clone(&wake), shutdown.clone());
            let worker =
                tokio::spawn(
                    async move { drive_live_stream(worker_host, receiver, &worker_wake, &worker_shutdown).await },
                );
            Self { session, fetches, wake, shutdown, worker, _server: server }
        }

        async fn set(&mut self, next: LiveStreamSession) -> (WatchLiveCapabilities, Option<Degradation>) {
            *self.session.lock().unwrap() = next;
            self.wake.notify_one();
            self.fetches.recv().await.unwrap()
        }

        async fn stop(self) {
            self.shutdown.cancel();
            self.worker.await.unwrap();
        }
    }

    #[tokio::test(start_paused = true)]
    async fn lease_wakes_start_capture_and_stop_clears_the_frame() {
        let lease = session(ID, true);
        let (host, mut requests, _) = host(expiry() - 1_000);
        let mut driver = Driver::start(&host, LiveStreamSession::default());
        driver.fetches.recv().await.unwrap();
        assert!(requests.try_recv().is_err(), "inactive lease never requests a capture");
        driver.set(lease.clone()).await;
        answer(requests.recv().await.unwrap());
        let item = tokio::time::timeout(Duration::from_secs(1), host.outbox.next()).await.unwrap();
        assert_eq!(item.session_id(), lease.id.unwrap());
        host.outbox.offer_jpeg(LiveFrame { session_id: lease.id.unwrap(), frame: vec![9] });
        driver.set(LiveStreamSession::default()).await;
        tokio::task::yield_now().await;
        assert!(host.outbox.try_take().is_none());
        driver.stop().await;
    }

    #[test]
    fn capture_time_counts_toward_the_target_interval_with_a_floor() {
        assert_eq!(capture_delay(Duration::from_millis(125), Duration::from_millis(100)), Duration::from_millis(25));
        assert_eq!(
            capture_delay(Duration::from_millis(125), Duration::from_millis(200)),
            Duration::from_millis(MIN_CAPTURE_PAUSE_MILLIS)
        );
        assert_eq!(capture_delay(Duration::from_millis(125), Duration::ZERO), Duration::from_millis(125));
    }

    #[test]
    fn reconcile_updates_limits_while_running_and_restarts_on_any_stream_change() {
        let first = session(ID, true);
        let same_id = session(ID, true);
        let other_id = session(OTHER, true);
        let inactive = session(ID, false);
        let now = expiry() - 1_000;
        assert_eq!(reconcile_action(None, &first, now, false), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&first), &same_id, now, true), ReconcileAction::Keep);
        assert_eq!(
            reconcile_action(Some(&first), &same_id, now, false),
            ReconcileAction::Restart,
            "a same-ID renewal must restart a worker that already exited"
        );
        assert_eq!(reconcile_action(Some(&first), &other_id, now, true), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&first), &inactive, now, true), ReconcileAction::Stop);
        assert_eq!(reconcile_action(Some(&first), &first, expiry(), true), ReconcileAction::Stop);
        assert_eq!(reconcile_action(None, &inactive, now, false), ReconcileAction::Stop);
        let high = h264(ID, WatchLiveProfile::H264_720p15, 0);
        let lower = h264(ID, WatchLiveProfile::H264_540p15, 1);
        assert_eq!(reconcile_action(Some(&first), &high, now, true), ReconcileAction::Restart);
        assert_eq!(reconcile_action(Some(&high), &high.clone(), now, true), ReconcileAction::Keep);
        assert_eq!(reconcile_action(Some(&high), &lower, now, true), ReconcileAction::Restart, "a degrade restarts");
    }

    #[test]
    fn only_the_still_active_session_in_the_same_mode_may_send() {
        let now = expiry() - 1_000;
        let active = session(ID, true);
        let key = mjpeg_key(&active);
        assert!(should_send(key, Some(&active), now));
        assert!(!should_send(key, Some(&active), expiry()));
        assert!(!should_send(key, Some(&session(OTHER, true)), now));
        assert!(!should_send(key, None, now));
        let h264_key = stream_key(&h264(ID, WatchLiveProfile::H264_540p15, 0)).unwrap();
        assert!(!should_send(h264_key, Some(&h264(ID, WatchLiveProfile::H264_540p10, 1)), now));
        assert!(!should_send(h264_key, Some(&active), now), "an MJPEG session never takes H.264 data");
    }

    fn chunk(keyframe: bool, timestamp_micros: u64) -> EncodedVideoChunk {
        EncodedVideoChunk {
            timestamp_micros,
            duration_micros: None,
            width: 960,
            height: 540,
            keyframe,
            data: if keyframe { KEY.to_vec() } else { DELTA.to_vec() },
        }
    }

    async fn next_packet(host: &Host) -> Vec<u8> {
        match tokio::time::timeout(Duration::from_secs(2), host.outbox.next()).await.expect("a packet") {
            OutboxItem::Encoded { packet, .. } => packet,
            other => panic!("expected H.264, got {other:?}"),
        }
    }

    #[tokio::test(start_paused = true)]
    async fn an_h264_lease_runs_one_encoder_and_emits_ordered_tcls_v2() {
        let (host, mut requests, mut started) = host(expiry() - 1_000);
        let mut driver = Driver::start(&host, LiveStreamSession::default());
        let (advertised, _) = driver.fetches.recv().await.unwrap();
        assert_eq!(advertised.profiles(), WatchLiveProfile::ALL, "the GET names every probed profile");
        driver.set(h264(ID, WatchLiveProfile::H264_720p15, 0)).await;
        let encoder = started.recv().await.unwrap();
        assert_eq!(encoder.config, EncoderConfig::for_profile(WatchLiveProfile::H264_720p15));
        assert_eq!(
            (encoder.config.max_width, encoder.config.fps, encoder.config.keyframe_interval_frames),
            (1280, 15, 15)
        );
        // A delta before any keyframe is not decodable and never leaves.
        assert!(encoder.sink.push(chunk(false, 0)));
        assert!(encoder.sink.push(chunk(true, 66_666)));
        assert!(encoder.sink.push(chunk(false, 133_333)));
        let key = next_packet(&host).await;
        assert_eq!((&key[0..4], key[4], key[5], key[6]), (&b"TCLS"[..], 2, 1, 1));
        assert_eq!(&key[8..24], uuid::Uuid::parse_str(ID).unwrap().as_bytes());
        let key_sequence = u64::from_be_bytes(key[24..32].try_into().unwrap());
        let delta = next_packet(&host).await;
        assert_eq!(delta[6], 0);
        assert_eq!(u64::from_be_bytes(delta[24..32].try_into().unwrap()), key_sequence + 1);
        assert!(
            u64::from_be_bytes(delta[32..40].try_into().unwrap()) > u64::from_be_bytes(key[32..40].try_into().unwrap())
        );
        assert!(requests.try_recv().is_err(), "an H.264 lease never takes still captures");
        // Ending the lease drops the encoder.
        driver.set(LiveStreamSession::default()).await;
        tokio::task::yield_now().await;
        assert!(encoder.dropped.load(Ordering::SeqCst), "the encoder outlived its lease");
        assert!(encoder.sink.is_closed());
        driver.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn replacement_and_expiry_stop_the_old_encoder_before_another_starts() {
        let (host, _requests, mut started) = host(expiry() - 1_000);
        let mut driver = Driver::start(&host, h264(ID, WatchLiveProfile::H264_540p15, 0));
        let first = started.recv().await.unwrap();
        assert!(first.sink.push(chunk(true, 0)));
        let _ = next_packet(&host).await;
        driver.set(h264(OTHER, WatchLiveProfile::H264_540p15, 0)).await;
        let second = started.recv().await.unwrap();
        assert!(first.dropped.load(Ordering::SeqCst), "replacement must stop the old encoder first");
        // Output from the old encoder can no longer reach the socket.
        assert!(!first.sink.push(chunk(true, 0)));
        assert!(host.outbox.try_take().is_none());
        assert!(second.sink.push(chunk(true, 0)));
        assert_eq!(next_packet(&host).await[8..24], *uuid::Uuid::parse_str(OTHER).unwrap().as_bytes());
        // The lease expires locally: the encoder stops without a new GET.
        host.clock.store(expiry(), Ordering::SeqCst);
        tokio::time::sleep(ENCODED_TICK * 2).await;
        assert!(second.dropped.load(Ordering::SeqCst), "the encoder outlived an expired lease");
        driver.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn protection_stops_the_encoder_and_discards_in_flight_output() {
        let (host, _requests, mut started) = host(expiry() - 1_000);
        let driver = Driver::start(&host, h264(ID, WatchLiveProfile::H264_540p15, 0));
        let encoder = started.recv().await.unwrap();
        assert!(encoder.sink.push(chunk(true, 0)));
        let _ = next_packet(&host).await;
        // Protection begins while an access unit is in flight.
        host.protected.store(true, Ordering::SeqCst);
        assert!(encoder.sink.push(chunk(false, 66_666)));
        tokio::time::sleep(ENCODED_TICK * 2).await;
        assert!(host.outbox.try_take().is_none(), "protected output must not escape");
        assert!(encoder.dropped.load(Ordering::SeqCst), "the encoder kept capturing a protected screen");
        assert!(started.try_recv().is_err(), "no encoder starts while protected");
        host.protected.store(false, Ordering::SeqCst);
        let resumed = started.recv().await.unwrap();
        // The resumed stream starts at a keyframe, with later sequence numbers.
        assert!(resumed.sink.push(chunk(false, 0)));
        assert!(resumed.sink.push(chunk(true, 0)));
        let packet = next_packet(&host).await;
        assert_eq!(packet[6], 1);
        assert!(u64::from_be_bytes(packet[24..32].try_into().unwrap()) > 2);
        driver.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_encoder_failure_degrades_this_session_once_and_a_new_lease_probes_again() {
        let (host, _requests, mut started) = host(expiry() - 1_000);
        let mut driver = Driver::start(&host, h264(ID, WatchLiveProfile::H264_720p15, 0));
        let _ = driver.fetches.recv().await.unwrap();
        let first = started.recv().await.unwrap();
        first.sink.failed("test");
        // The next GET carries the degradation for this session only.
        let (advertised, degraded) = driver.fetches.recv().await.unwrap();
        assert_eq!(
            degraded,
            Some(Degradation { session_id: ID.parse().unwrap(), profile: WatchLiveProfile::H264_720p15 })
        );
        assert!(!advertised.contains(WatchLiveProfile::H264_720p15));
        assert!(first.dropped.load(Ordering::SeqCst));
        driver.set(h264(ID, WatchLiveProfile::H264_540p15, 1)).await;
        let second = started.recv().await.unwrap();
        assert_eq!(second.config.profile, WatchLiveProfile::H264_540p15);
        // A server that offers the failed profile again gets nothing.
        let (_, degraded) = driver.set(h264(ID, WatchLiveProfile::H264_720p15, 2)).await;
        assert!(degraded.is_some());
        tokio::task::yield_now().await;
        assert!(second.dropped.load(Ordering::SeqCst));
        assert!(started.try_recv().is_err(), "no upgrade within a degraded session");
        // A new lease probes the best profile again.
        let (advertised, degraded) = driver.set(h264(OTHER, WatchLiveProfile::H264_720p15, 0)).await;
        let _ = (advertised, degraded);
        let (advertised, degraded) = driver.set(h264(OTHER, WatchLiveProfile::H264_720p15, 0)).await;
        assert_eq!(degraded, None);
        assert!(advertised.contains(WatchLiveProfile::H264_720p15));
        assert_eq!(started.recv().await.unwrap().config.profile, WatchLiveProfile::H264_720p15);
        driver.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn a_host_without_the_selected_encoder_degrades_instead_of_guessing() {
        let (host, _requests, mut started) = host(expiry() - 1_000);
        host.fail_start.store(true, Ordering::SeqCst);
        let mut driver = Driver::start(&host, h264(ID, WatchLiveProfile::H264_540p10, 0));
        let _ = driver.fetches.recv().await.unwrap();
        let (advertised, degraded) = driver.fetches.recv().await.unwrap();
        assert_eq!(degraded.map(|d| d.profile), Some(WatchLiveProfile::H264_540p10));
        assert_eq!(advertised.profiles(), [WatchLiveProfile::Mjpeg540p10, WatchLiveProfile::Mjpeg360p8]);
        assert!(started.try_recv().is_err());
        driver.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn an_older_server_never_gets_tcls_v2() {
        // An older server returns no profile: MJPEG, even from an H.264 host.
        let (host, mut requests, mut started) = host(expiry() - 1_000);
        let driver = Driver::start(&host, session(ID, true));
        answer(requests.recv().await.unwrap());
        let item = tokio::time::timeout(Duration::from_secs(1), host.outbox.next()).await.unwrap();
        assert!(matches!(item, OutboxItem::Jpeg(ref frame) if frame.frame[4] == 1));
        assert!(started.try_recv().is_err(), "no encoder without an explicit H.264 selection");
        driver.stop().await;
    }

    #[tokio::test(start_paused = true)]
    async fn outbox_resyncs_ask_the_encoder_for_a_keyframe() {
        let (host, _requests, mut started) = host(expiry() - 1_000);
        let driver = Driver::start(&host, h264(ID, WatchLiveProfile::H264_540p15, 0));
        let encoder = started.recv().await.unwrap();
        assert!(encoder.sink.push(chunk(true, 0)));
        // Nobody drains the outbox: it overflows and asks for a keyframe.
        for index in 1..=crate::MAX_QUEUED_CHUNKS as u64 + 1 {
            assert!(encoder.sink.push(chunk(false, index * 66_666)));
            tokio::task::yield_now().await;
        }
        tokio::time::sleep(Duration::from_millis(10)).await;
        assert!(encoder.keyframes.load(Ordering::SeqCst) >= 1);
        assert!(host.outbox.queued().0 <= crate::MAX_QUEUED_CHUNKS);
        driver.stop().await;
    }
}
