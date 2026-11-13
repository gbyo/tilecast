//! The encoded Watch Live stream contract between Core and a native host.
//!
//! [`crate::CapturedFrame`] stays the still JPEG abstraction (Live Preview
//! and the MJPEG Watch Live profiles). An H.264 profile instead runs one
//! persistent host encoder for the lease:
//!
//! - Core decides when an encoder may exist, which profile it encodes, and
//!   what happens to its output (protected-state checks, session checks,
//!   backpressure, and runtime downgrade).
//! - The host owns final-output capture, pixel conversion, the platform
//!   encoder and its configuration. It pushes [`EncodedVideoChunk`]s into
//!   an [`EncodedChunkSink`] and never sees the socket.
//!
//! Dropping the [`LiveEncoder`] handle must stop the encoder and free it at
//! once. A host encoder that cannot keep up drops raw frames before
//! encoding; once it hands Core an access unit, only Core drops it, and Core
//! never forwards a delta after a dropped predecessor.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::Duration;

use player_client::live_stream::{MAX_ACCESS_UNIT_BYTES, WatchLiveProfile};
use tokio::sync::mpsc;

/// One complete H.264 Annex B access unit from a host encoder. A keyframe
/// carries SPS and PPS followed by its IDR slice, so a decoder can start at
/// any keyframe.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedVideoChunk {
    /// Presentation timestamp in microseconds, non-decreasing per encoder.
    pub timestamp_micros: u64,
    /// Frame duration in microseconds, when the encoder reports one.
    pub duration_micros: Option<u32>,
    pub width: u32,
    pub height: u32,
    pub keyframe: bool,
    /// Annex B bytes, at most [`MAX_ACCESS_UNIT_BYTES`].
    pub data: Vec<u8>,
}

/// What a host encoder must produce for one lease.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct EncoderConfig {
    pub profile: WatchLiveProfile,
    pub max_width: u32,
    pub max_height: u32,
    pub fps: u32,
    pub target_bitrate: u32,
    /// About one second of frames between IDRs.
    pub keyframe_interval_frames: u32,
}

impl EncoderConfig {
    pub fn for_profile(profile: WatchLiveProfile) -> Self {
        let (max_width, max_height) = profile.max_dimensions();
        Self {
            profile,
            max_width,
            max_height,
            fps: profile.fps(),
            target_bitrate: profile.target_bitrate(),
            keyframe_interval_frames: profile.fps(),
        }
    }

    pub fn frame_interval(&self) -> Duration {
        Duration::from_micros(1_000_000 / u64::from(self.fps.max(1)))
    }
}

/// Fits `(width, height)` inside the profile bounds without upscaling,
/// keeping the aspect ratio and even dimensions for 4:2:0 encoding. Every
/// host uses this so output dimensions agree with Core's validation.
pub fn fit_encoder_dimensions(width: u32, height: u32, max_width: u32, max_height: u32) -> Option<(u32, u32)> {
    if width == 0 || height == 0 || max_width < 16 || max_height < 16 {
        return None;
    }
    let scale = (f64::from(max_width) / f64::from(width)).min(f64::from(max_height) / f64::from(height)).min(1.0);
    let even = |value: f64| ((value.floor() as u32) & !1).max(16);
    let (out_width, out_height) = (even(f64::from(width) * scale), even(f64::from(height) * scale));
    (out_width <= max_width && out_height <= max_height).then_some((out_width, out_height))
}

/// Ephemeral timing the host reports for one captured raw frame. Nothing
/// here is persisted; it only feeds [`DowngradeMonitor`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct EncoderSample {
    /// Time spent acquiring and converting the frame.
    pub capture: Duration,
    /// Time from encoder input to output, when known.
    pub encode: Option<Duration>,
    /// The frame missed its slot (acquired late or dropped before encoding
    /// because the encoder was busy).
    pub missed_deadline: bool,
    /// Raw frames waiting for the encoder, when known.
    pub backlog: u32,
}

/// What a sink hands Core. Public so host adapters can test their routing.
#[derive(Debug)]
pub enum SinkEvent {
    Chunk { sequence: u64, chunk: EncodedVideoChunk },
    Sample(EncoderSample),
    Failed(&'static str),
}

#[derive(Debug)]
struct SinkShared {
    /// Every pushed access unit takes a sequence number, even one the sink
    /// drops, so a dropped predecessor shows up as a gap downstream.
    sequence: Arc<AtomicU64>,
    /// A chunk was dropped: deltas are refused until a keyframe.
    awaiting_keyframe: AtomicBool,
    keyframe_wanted: AtomicBool,
}

/// The non-blocking, bounded handoff from a host encoder thread to Core.
/// Cloneable and `Send`; safe to call from any thread.
#[derive(Debug, Clone)]
pub struct EncodedChunkSink {
    events: mpsc::Sender<SinkEvent>,
    shared: Arc<SinkShared>,
}

/// Raw handoff capacity. A host that outpaces Core loses access units here,
/// and the sink then waits for a keyframe.
const SINK_CAPACITY: usize = 8;

impl EncodedChunkSink {
    /// A sink and Core's receiving end. Core creates one per encoder; hosts
    /// use it only in tests of their own routing.
    pub fn new(sequence: Arc<AtomicU64>) -> (Self, mpsc::Receiver<SinkEvent>) {
        let (events, receiver) = mpsc::channel(SINK_CAPACITY);
        let shared = Arc::new(SinkShared {
            sequence,
            awaiting_keyframe: AtomicBool::new(false),
            keyframe_wanted: AtomicBool::new(false),
        });
        (Self { events, shared }, receiver)
    }

    /// Hands one access unit to Core. Returns `false` when it was dropped
    /// (oversized, Core is behind, a predecessor was dropped, or the stream
    /// ended); the host should then produce a keyframe soon
    /// ([`Self::take_keyframe_request`]).
    pub fn push(&self, chunk: EncodedVideoChunk) -> bool {
        let sequence = self.shared.sequence.fetch_add(1, Ordering::AcqRel);
        if chunk.data.len() > MAX_ACCESS_UNIT_BYTES
            || (!chunk.keyframe && self.shared.awaiting_keyframe.load(Ordering::Acquire))
        {
            self.drop_dependency();
            return false;
        }
        let keyframe = chunk.keyframe;
        match self.events.try_send(SinkEvent::Chunk { sequence, chunk }) {
            Ok(()) => {
                if keyframe {
                    self.shared.awaiting_keyframe.store(false, Ordering::Release);
                }
                true
            }
            Err(_) => {
                self.drop_dependency();
                false
            }
        }
    }

    fn drop_dependency(&self) {
        self.shared.awaiting_keyframe.store(true, Ordering::Release);
        self.shared.keyframe_wanted.store(true, Ordering::Release);
    }

    /// Ephemeral timing for the downgrade policy. Lost when Core is behind.
    pub fn report(&self, sample: EncoderSample) {
        let _ = self.events.try_send(SinkEvent::Sample(sample));
    }

    /// The encoder failed for good. Core stops it and degrades the session.
    pub fn failed(&self, reason: &'static str) {
        let _ = self.events.try_send(SinkEvent::Failed(reason));
    }

    /// Whether a sink-side drop asked for a keyframe since the last call.
    pub fn take_keyframe_request(&self) -> bool {
        self.shared.keyframe_wanted.swap(false, Ordering::AcqRel)
    }

    /// Core no longer listens: the host must stop encoding.
    pub fn is_closed(&self) -> bool {
        self.events.is_closed()
    }
}

/// A running host encoder. Dropping it stops capture and encoding and frees
/// the encoder immediately.
pub trait LiveEncoder: Send + Sync {
    /// Ask for an IDR (with SPS and PPS) as soon as practical.
    fn request_keyframe(&self);
}

/// Conservative runtime degradation for one H.264 session. It evaluates
/// fixed windows after a warm-up and degrades only after
/// [`Self::BAD_WINDOWS`] consecutive unsustainable windows; a good window
/// resets the count. It never recommends an upgrade.
#[derive(Debug, Clone)]
pub struct DowngradeMonitor {
    fps: u32,
    elapsed: Duration,
    window: Window,
    bad_windows: u32,
}

#[derive(Debug, Clone, Default)]
struct Window {
    elapsed: Duration,
    chunks: u32,
    samples: u32,
    missed: u32,
    slow_captures: u32,
    resyncs: u32,
}

/// What a finished window says about the profile.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Sustainability {
    Measuring,
    Sustainable,
    Unsustainable(&'static str),
    Degrade(&'static str),
}

impl DowngradeMonitor {
    pub const WARM_UP: Duration = Duration::from_secs(3);
    pub const WINDOW: Duration = Duration::from_secs(5);
    pub const BAD_WINDOWS: u32 = 2;
    /// Output below this fraction of the profile's FPS is unsustainable.
    pub const MIN_FPS_RATIO: f64 = 0.6;
    /// Missed or slow frames above this fraction are unsustainable.
    pub const MAX_LATE_RATIO: f64 = 0.3;
    /// Outbox or transport resyncs per window that are unsustainable.
    pub const MAX_RESYNCS: u32 = 2;

    pub fn new(profile: WatchLiveProfile) -> Self {
        Self { fps: profile.fps(), elapsed: Duration::ZERO, window: Window::default(), bad_windows: 0 }
    }

    pub fn chunk(&mut self) {
        self.window.chunks += 1;
    }

    pub fn sample(&mut self, sample: EncoderSample) {
        let budget = Duration::from_micros(1_000_000 / u64::from(self.fps.max(1)));
        self.window.samples += 1;
        if sample.missed_deadline {
            self.window.missed += 1;
        }
        if sample.capture + sample.encode.unwrap_or_default() > budget || sample.backlog > 2 {
            self.window.slow_captures += 1;
        }
    }

    pub fn resync(&mut self) {
        self.window.resyncs += 1;
    }

    /// Advances the clock by `delta` and judges a window when one is full.
    pub fn tick(&mut self, delta: Duration) -> Sustainability {
        self.elapsed += delta;
        if self.elapsed <= Self::WARM_UP {
            self.window = Window::default();
            return Sustainability::Measuring;
        }
        self.window.elapsed += delta;
        if self.window.elapsed < Self::WINDOW {
            return Sustainability::Measuring;
        }
        let window = std::mem::take(&mut self.window);
        let seconds = window.elapsed.as_secs_f64();
        let reason = if f64::from(window.chunks) / seconds < f64::from(self.fps) * Self::MIN_FPS_RATIO {
            Some("output_fps")
        } else if window.resyncs >= Self::MAX_RESYNCS {
            Some("transport_resync")
        } else if window.samples > 0
            && f64::from(window.missed + window.slow_captures) / f64::from(window.samples) > Self::MAX_LATE_RATIO
        {
            Some("frame_deadline")
        } else {
            None
        };
        match reason {
            None => {
                self.bad_windows = 0;
                Sustainability::Sustainable
            }
            Some(reason) => {
                self.bad_windows += 1;
                if self.bad_windows >= Self::BAD_WINDOWS {
                    Sustainability::Degrade(reason)
                } else {
                    Sustainability::Unsustainable(reason)
                }
            }
        }
    }
}

/// The next profile down after `profile` fails: 720p15 → 540p15 → 540p10 →
/// MJPEG. The server picks the exact MJPEG profile from what both sides
/// support.
pub fn degraded_capabilities(
    capabilities: &player_client::live_stream::WatchLiveCapabilities,
    failed: WatchLiveProfile,
) -> player_client::live_stream::WatchLiveCapabilities {
    capabilities.below(failed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn chunk(keyframe: bool) -> EncodedVideoChunk {
        EncodedVideoChunk {
            timestamp_micros: 0,
            duration_micros: None,
            width: 960,
            height: 540,
            keyframe,
            data: vec![0, 0, 1, if keyframe { 0x65 } else { 0x41 }],
        }
    }

    #[tokio::test]
    async fn a_sink_drop_numbers_the_gap_and_waits_for_a_keyframe() {
        let (sink, mut events) = EncodedChunkSink::new(Arc::new(AtomicU64::new(10)));
        assert!(sink.push(chunk(true)));
        for _ in 1..SINK_CAPACITY {
            assert!(sink.push(chunk(false)));
        }
        assert!(!sink.push(chunk(false)), "Core is behind: the handoff is full");
        assert!(sink.take_keyframe_request());
        assert!(!sink.take_keyframe_request());
        // Drain Core's side: the deltas after the drop stay refused.
        let mut sequences = Vec::new();
        while let Ok(SinkEvent::Chunk { sequence, .. }) = events.try_recv() {
            sequences.push(sequence);
        }
        assert_eq!(sequences, (10..10 + SINK_CAPACITY as u64).collect::<Vec<_>>());
        assert!(!sink.push(chunk(false)), "a delta after a dropped predecessor is never forwarded");
        assert!(sink.push(chunk(true)));
        match events.try_recv() {
            Ok(SinkEvent::Chunk { sequence, chunk }) => {
                assert!(chunk.keyframe);
                assert_eq!(sequence, 10 + SINK_CAPACITY as u64 + 2, "the two dropped units left a gap");
            }
            other => panic!("unexpected {other:?}"),
        }
        assert!(sink.push(chunk(false)));
    }

    #[test]
    fn an_oversized_access_unit_is_dropped_and_a_closed_sink_says_so() {
        let (sink, events) = EncodedChunkSink::new(Arc::new(AtomicU64::new(0)));
        let mut huge = chunk(true);
        huge.data = vec![0; MAX_ACCESS_UNIT_BYTES + 1];
        assert!(!sink.push(huge));
        assert!(!sink.is_closed());
        drop(events);
        assert!(sink.is_closed());
        assert!(!sink.push(chunk(true)));
    }

    #[test]
    fn encoder_dimensions_fit_even_and_never_upscale() {
        assert_eq!(fit_encoder_dimensions(1920, 1080, 1280, 720), Some((1280, 720)));
        assert_eq!(fit_encoder_dimensions(1920, 1080, 960, 540), Some((960, 540)));
        assert_eq!(fit_encoder_dimensions(1080, 1920, 960, 540), Some((302, 540)));
        assert_eq!(fit_encoder_dimensions(641, 361, 1280, 720), Some((640, 360)));
        assert_eq!(fit_encoder_dimensions(0, 1080, 960, 540), None);
    }

    fn run(monitor: &mut DowngradeMonitor, seconds: u32, fps: u32, missed_every: Option<u32>) -> Vec<Sustainability> {
        let mut verdicts = Vec::new();
        for second in 0..seconds {
            for frame in 0..fps {
                monitor.chunk();
                monitor.sample(EncoderSample {
                    capture: Duration::from_millis(5),
                    missed_deadline: missed_every.is_some_and(|every| (second * fps + frame).is_multiple_of(every)),
                    ..EncoderSample::default()
                });
            }
            let verdict = monitor.tick(Duration::from_secs(1));
            if verdict != Sustainability::Measuring {
                verdicts.push(verdict);
            }
        }
        verdicts
    }

    #[test]
    fn a_sustained_profile_never_degrades() {
        let mut monitor = DowngradeMonitor::new(WatchLiveProfile::H264_720p15);
        assert!(run(&mut monitor, 60, 15, None).iter().all(|verdict| *verdict == Sustainability::Sustainable));
    }

    #[test]
    fn degradation_needs_two_consecutive_bad_windows() {
        let mut monitor = DowngradeMonitor::new(WatchLiveProfile::H264_720p15);
        // Warm-up, then one bad window, then a good one: hysteresis resets.
        let mut verdicts = run(&mut monitor, 8, 6, None);
        verdicts.extend(run(&mut monitor, 5, 15, None));
        assert_eq!(verdicts, [Sustainability::Unsustainable("output_fps"), Sustainability::Sustainable]);
        let verdicts = run(&mut monitor, 10, 6, None);
        assert_eq!(verdicts, [Sustainability::Unsustainable("output_fps"), Sustainability::Degrade("output_fps")]);
    }

    #[test]
    fn missed_deadlines_and_resyncs_are_unsustainable() {
        let mut monitor = DowngradeMonitor::new(WatchLiveProfile::H264_540p15);
        assert_eq!(run(&mut monitor, 13, 15, Some(2)).last(), Some(&Sustainability::Degrade("frame_deadline")));
        let mut monitor = DowngradeMonitor::new(WatchLiveProfile::H264_540p15);
        let _ = monitor.tick(DowngradeMonitor::WARM_UP);
        for _ in 0..2 {
            for _ in 0..DowngradeMonitor::MAX_RESYNCS {
                monitor.resync();
            }
            for _ in 0..75 {
                monitor.chunk();
            }
            let _ = monitor.tick(Duration::from_millis(1));
            let verdict = monitor.tick(DowngradeMonitor::WINDOW);
            assert!(matches!(
                verdict,
                Sustainability::Unsustainable("transport_resync") | Sustainability::Degrade("transport_resync")
            ));
        }
    }

    #[test]
    fn degradation_steps_down_one_profile_at_a_time() {
        let all = player_client::live_stream::WatchLiveCapabilities::new(WatchLiveProfile::ALL);
        let first = degraded_capabilities(&all, WatchLiveProfile::H264_720p15);
        assert_eq!(first.profiles()[0], WatchLiveProfile::H264_540p15);
        let second = degraded_capabilities(&first, WatchLiveProfile::H264_540p15);
        assert_eq!(second.profiles()[0], WatchLiveProfile::H264_540p10);
        let third = degraded_capabilities(&second, WatchLiveProfile::H264_540p10);
        assert_eq!(third.profiles()[0], WatchLiveProfile::Mjpeg540p10);
    }
}
