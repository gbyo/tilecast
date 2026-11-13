//! Edge's Watch Live H.264 encoder session: the daemon side of the WPE
//! renderer's persistent GStreamer encoder.
//!
//! Core decides when an encoder may exist (an H.264 lease, an unprotected
//! screen) and what happens to its output. This adapter starts and stops the
//! renderer's encoder over IPC, routes its access units into Core's
//! [`player_core::EncodedChunkSink`], and reports the H.264 profiles the
//! renderer's runtime probe found. At most one encoder stream exists; a
//! chunk for any other stream ID is dropped.

use std::sync::{Arc, Mutex};

use base64::Engine as _;
use edge_ipc::SessionHandle;
use edge_protocol::bounded::ShortToken;
use edge_protocol::ipc::event::{
    Event, LiveCapabilities, LiveChunk, LiveEncoderStart, LiveEncoderState, LiveEncoderStatus, LiveEncoderStream,
};
use player_core::{
    CaptureError, EncodedChunkSink, EncodedVideoChunk, EncoderConfig, EncoderSample, LiveEncoder,
    WatchLiveCapabilities, WatchLiveProfile,
};

#[derive(Debug)]
struct ActiveStream {
    stream_id: uuid::Uuid,
    sink: EncodedChunkSink,
    max_width: u32,
    max_height: u32,
}

/// The daemon's encoder state: the renderer's probed profiles and the one
/// running stream.
#[derive(Debug, Default)]
pub struct LiveEncoders {
    capabilities: Mutex<Vec<WatchLiveProfile>>,
    active: Arc<Mutex<Option<ActiveStream>>>,
}

fn lock<T>(mutex: &Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|error| error.into_inner())
}

impl LiveEncoders {
    /// The MJPEG profiles every Edge renderer captures, plus the H.264
    /// profiles its encoder probe actually negotiated.
    pub fn capabilities(&self) -> WatchLiveCapabilities {
        WatchLiveCapabilities::new(lock(&self.capabilities).iter().copied().chain([WatchLiveProfile::Mjpeg540p10]))
    }

    /// `renderer.live_capabilities`: only known H.264 profile IDs count.
    pub fn set_capabilities(&self, report: &LiveCapabilities) {
        let profiles: Vec<_> = report
            .profiles
            .iter()
            .filter_map(|id| WatchLiveProfile::from_id(id.as_str()))
            .filter(|profile| profile.transport() == player_core::WatchLiveTransport::H264)
            .collect();
        tracing::info!(
            component = "live_stream",
            event = "encoder_probe",
            encoder = report.encoder.as_ref().map(ShortToken::as_str).unwrap_or("none"),
            hardware = report.hardware,
            profiles = profiles.len()
        );
        *lock(&self.capabilities) = profiles;
    }

    /// The renderer went away: its encoder and its probe went with it.
    pub fn renderer_disconnected(&self) {
        lock(&self.capabilities).clear();
        if let Some(active) = lock(&self.active).take() {
            active.sink.failed("renderer_disconnected");
        }
    }

    /// Starts the renderer's encoder for `config` on `session`, replacing
    /// any running stream.
    pub fn start(
        &self,
        session: SessionHandle,
        config: EncoderConfig,
        sink: EncodedChunkSink,
    ) -> Result<Box<dyn LiveEncoder>, CaptureError> {
        if !lock(&self.capabilities).contains(&config.profile) {
            return Err(CaptureError::RendererUnavailable);
        }
        let stream_id = uuid::Uuid::new_v4();
        let profile = ShortToken::new(config.profile.id()).map_err(|_| CaptureError::Invalid)?;
        // Register first so the first chunk cannot race the registration.
        let previous = lock(&self.active).replace(ActiveStream {
            stream_id,
            sink,
            max_width: config.max_width,
            max_height: config.max_height,
        });
        if let Some(previous) = previous {
            let _ = session.send_event(Event::LiveEncoderStop(LiveEncoderStream { stream_id: previous.stream_id }));
        }
        let start = Event::LiveEncoderStart(LiveEncoderStart {
            stream_id,
            profile,
            max_width: config.max_width,
            max_height: config.max_height,
            fps: config.fps,
            bitrate: config.target_bitrate,
            keyframe_interval: config.keyframe_interval_frames,
        });
        if session.send_event(start).is_err() {
            let mut active = lock(&self.active);
            if active.as_ref().is_some_and(|active| active.stream_id == stream_id) {
                *active = None;
            }
            return Err(CaptureError::RendererDisconnected);
        }
        Ok(Box::new(EdgeLiveEncoder { stream_id, session, active: Arc::clone(&self.active) }))
    }

    /// `renderer.live_chunk`: one access unit for the running stream.
    pub fn chunk(&self, chunk: LiveChunk) {
        let active = lock(&self.active);
        let Some(stream) = active.as_ref().filter(|stream| stream.stream_id == chunk.stream_id) else { return };
        if !chunk.within_limits() || chunk.width > stream.max_width || chunk.height > stream.max_height {
            stream.sink.failed("renderer_chunk_invalid");
            return;
        }
        let Ok(data) = base64::engine::general_purpose::STANDARD.decode(chunk.data_base64.as_bytes()) else {
            stream.sink.failed("renderer_chunk_invalid");
            return;
        };
        let micros = |value: Option<u32>| std::time::Duration::from_micros(u64::from(value.unwrap_or(0)));
        let dropped = chunk.dropped_frames.unwrap_or(0);
        stream.sink.report(EncoderSample {
            capture: micros(chunk.capture_micros),
            encode: chunk.encode_micros.map(|value| micros(Some(value))),
            missed_deadline: false,
            backlog: 0,
        });
        for _ in 0..dropped.min(30) {
            stream.sink.report(EncoderSample { missed_deadline: true, ..EncoderSample::default() });
        }
        stream.sink.push(EncodedVideoChunk {
            timestamp_micros: chunk.timestamp_micros,
            duration_micros: None,
            width: chunk.width,
            height: chunk.height,
            keyframe: chunk.keyframe,
            data,
        });
    }

    /// `renderer.live_encoder`: a failure degrades the session in Core.
    pub fn state(&self, state: &LiveEncoderState) {
        let active = lock(&self.active);
        let Some(stream) = active.as_ref().filter(|stream| stream.stream_id == state.stream_id) else { return };
        match state.state {
            LiveEncoderStatus::Started => tracing::info!(
                component = "live_stream",
                event = "encoder_started",
                encoder = state.encoder.as_ref().map(ShortToken::as_str).unwrap_or("unknown")
            ),
            LiveEncoderStatus::Failed | LiveEncoderStatus::Stopped => {
                tracing::info!(component = "live_stream", event = "encoder_ended", code = state.code.as_str());
                stream.sink.failed("renderer_encoder_failed");
            }
        }
    }
}

/// Core's handle on the renderer's encoder. Dropping it stops the encoder.
struct EdgeLiveEncoder {
    stream_id: uuid::Uuid,
    session: SessionHandle,
    active: Arc<Mutex<Option<ActiveStream>>>,
}

impl LiveEncoder for EdgeLiveEncoder {
    fn request_keyframe(&self) {
        let _ = self.session.send_event(Event::LiveEncoderKeyframe(LiveEncoderStream { stream_id: self.stream_id }));
    }
}

impl Drop for EdgeLiveEncoder {
    fn drop(&mut self) {
        {
            let mut active = lock(&self.active);
            if active.as_ref().is_some_and(|active| active.stream_id == self.stream_id) {
                *active = None;
            }
        }
        let _ = self.session.send_event(Event::LiveEncoderStop(LiveEncoderStream { stream_id: self.stream_id }));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_core::watch_live::SinkEvent;
    use std::sync::atomic::AtomicU64;

    const KEY: [u8; 22] =
        [0, 0, 0, 1, 0x67, 0x42, 0, 0x28, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80, 0, 0, 1, 0x65, 0x88, 0x84];

    fn encoders_with_stream() -> (LiveEncoders, uuid::Uuid, tokio::sync::mpsc::Receiver<SinkEvent>) {
        let encoders = LiveEncoders::default();
        let (sink, events) = EncodedChunkSink::new(Arc::new(AtomicU64::new(1)));
        let stream_id = uuid::Uuid::new_v4();
        *lock(&encoders.active) = Some(ActiveStream { stream_id, sink, max_width: 960, max_height: 540 });
        (encoders, stream_id, events)
    }

    fn chunk(stream_id: uuid::Uuid, width: u32, data: &[u8]) -> LiveChunk {
        LiveChunk {
            stream_id,
            timestamp_micros: 0,
            width,
            height: 540,
            keyframe: true,
            data_base64: base64::engine::general_purpose::STANDARD.encode(data),
            capture_micros: Some(2_000),
            encode_micros: Some(8_000),
            dropped_frames: Some(2),
        }
    }

    #[test]
    fn capabilities_come_only_from_the_renderer_probe() {
        let encoders = LiveEncoders::default();
        assert_eq!(encoders.capabilities().profiles(), [WatchLiveProfile::Mjpeg540p10, WatchLiveProfile::Mjpeg360p8]);
        encoders.set_capabilities(&LiveCapabilities {
            profiles: vec![
                ShortToken::new("h264-540p15").unwrap(),
                ShortToken::new("mjpeg-540p10").unwrap(),
                ShortToken::new("h265-4k60").unwrap(),
            ],
            encoder: Some(ShortToken::new("openh264enc").unwrap()),
            hardware: false,
        });
        assert_eq!(
            encoders.capabilities().profiles(),
            [WatchLiveProfile::H264_540p15, WatchLiveProfile::Mjpeg540p10, WatchLiveProfile::Mjpeg360p8]
        );
        encoders.renderer_disconnected();
        assert!(!encoders.capabilities().contains(WatchLiveProfile::H264_540p15), "a restarted renderer probes again");
    }

    #[test]
    fn chunks_reach_only_the_running_stream_within_its_bounds() {
        let (encoders, stream_id, mut events) = encoders_with_stream();
        encoders.chunk(chunk(uuid::Uuid::new_v4(), 960, &KEY));
        assert!(events.try_recv().is_err(), "a stale stream's chunk is dropped");
        encoders.chunk(chunk(stream_id, 960, &KEY));
        let mut samples = 0;
        let mut pushed = None;
        while let Ok(event) = events.try_recv() {
            match event {
                SinkEvent::Sample(_) => samples += 1,
                SinkEvent::Chunk { chunk, .. } => pushed = Some(chunk),
                SinkEvent::Failed(reason) => panic!("unexpected failure {reason}"),
            }
        }
        assert_eq!(samples, 3, "one timing sample plus one per dropped raw frame");
        assert_eq!(pushed.expect("chunk").data, KEY);
        encoders.chunk(chunk(stream_id, 1280, &KEY));
        assert!(matches!(events.try_recv(), Ok(SinkEvent::Failed("renderer_chunk_invalid"))));
    }

    #[test]
    fn a_renderer_failure_or_disconnect_fails_the_stream() {
        let (encoders, stream_id, mut events) = encoders_with_stream();
        encoders.state(&LiveEncoderState {
            stream_id,
            state: LiveEncoderStatus::Failed,
            code: ShortToken::new("encoder_error").unwrap(),
            encoder: None,
        });
        assert!(matches!(events.try_recv(), Ok(SinkEvent::Failed(_))));
        encoders.renderer_disconnected();
        assert!(matches!(events.try_recv(), Ok(SinkEvent::Failed("renderer_disconnected"))));
        assert!(lock(&encoders.active).is_none());
    }
}
