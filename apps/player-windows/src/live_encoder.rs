//! Windows Watch Live H.264: a persistent Media Foundation encoder of the
//! final compositor output.
//!
//! Core starts an encoder only while Studio holds an H.264 lease on an
//! unprotected screen and drops it the moment that ends. While it runs, one
//! dedicated thread owns a persistent Windows Graphics Capture session of
//! the player's own window and one Media Foundation H.264 encoder:
//!
//! - the thread paces captures at the profile frame rate; a capture or
//!   encode that overruns its slot drops the next raw frame instead of
//!   queueing work, and an unchanged window reuses the last frame;
//! - BGRA is scaled and converted to NV12 in system memory on that thread,
//!   never on the UI thread;
//! - the encoder runs in low-latency mode, Baseline profile, constant
//!   bitrate, no B-frames, and an IDR about once a second. SPS and PPS are
//!   written before every IDR if the encoder does not already do so;
//! - access units go into Core's bounded sink. The socket is never touched.
//!
//! Capability: [`probe`] enumerates the H.264 encoder MFTs and encodes real
//! frames with each. A hardware MFT that produces a Baseline keyframe at
//! 1280x720 advertises `h264-720p15` and below; a software MFT starts at
//! `h264-540p15`; nothing working advertises no H.264 profile. The platform
//! name never decides it.

use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

use player_core::{
    CaptureError, EncodedChunkSink, EncodedVideoChunk, EncoderConfig, EncoderSample, LiveEncoder, WatchLiveProfile,
    fit_encoder_dimensions,
};

/// One captured frame: tight BGRA rows, top to bottom.
#[derive(Debug, Clone)]
pub struct Bgra {
    pub width: u32,
    pub height: u32,
    pub pixels: Arc<Vec<u8>>,
}

/// One access unit from an encoder.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EncodedUnit {
    pub data: Vec<u8>,
    pub keyframe: bool,
    /// Presentation time in 100 ns units.
    pub timestamp_hns: i64,
}

/// The persistent final-output capture.
pub trait FrameSource {
    /// The newest frame, waiting up to `timeout`. `Ok(None)`: nothing new.
    fn next_frame(&mut self, timeout: Duration) -> Result<Option<Bgra>, &'static str>;
}

/// The persistent H.264 encoder of one stream size.
pub trait H264Encoder {
    fn encode(&mut self, nv12: &[u8], timestamp_hns: i64, force_keyframe: bool) -> Result<Vec<EncodedUnit>, &'static str>;
    /// SPS and PPS the encoder reported out of band, if any.
    fn parameter_sets(&self) -> Option<Vec<u8>>;
}

/// Scales tight BGRA into the `width` x `height` NV12 the encoder takes
/// (BT.601 limited range, the H.264 default without VUI signalling).
/// Nearest-neighbour sampling of a 2x2 block per chroma sample keeps this
/// cheap enough for 15 FPS on the encoder thread.
pub fn bgra_to_nv12(frame: &Bgra, width: u32, height: u32) -> Option<Vec<u8>> {
    let (source_width, source_height) = (frame.width as usize, frame.height as usize);
    let (width, height) = (width as usize, height as usize);
    if source_width == 0
        || source_height == 0
        || width == 0
        || height == 0
        || width % 2 != 0
        || height % 2 != 0
        || frame.pixels.len() != source_width * source_height * 4
    {
        return None;
    }
    let columns: Vec<usize> = (0..width).map(|x| (x * source_width / width).min(source_width - 1)).collect();
    let mut out = vec![0u8; width * height * 3 / 2];
    let (luma, chroma) = out.split_at_mut(width * height);
    let pixel = |x: usize, y: usize| {
        let at = (y * source_width + x) * 4;
        let p = &frame.pixels[at..at + 3];
        (i32::from(p[2]), i32::from(p[1]), i32::from(p[0]))
    };
    for y in 0..height {
        let source_y = (y * source_height / height).min(source_height - 1);
        for (x, &source_x) in columns.iter().enumerate() {
            let (r, g, b) = pixel(source_x, source_y);
            luma[y * width + x] = (((66 * r + 129 * g + 25 * b + 128) >> 8) + 16).clamp(16, 235) as u8;
        }
    }
    for y in (0..height).step_by(2) {
        let source_y = (y * source_height / height).min(source_height - 1);
        for x in (0..width).step_by(2) {
            let (r, g, b) = pixel(columns[x], source_y);
            let at = (y / 2) * width + x;
            chroma[at] = (((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128).clamp(16, 240) as u8;
            chroma[at + 1] = (((112 * r - 94 * g - 18 * b + 128) >> 8) + 128).clamp(16, 240) as u8;
        }
    }
    Some(out)
}

fn nal_types(data: &[u8]) -> Vec<u8> {
    let mut types = Vec::new();
    let mut index = 0;
    while index + 3 < data.len() {
        if data[index] == 0 && data[index + 1] == 0 && data[index + 2] == 1 {
            types.push(data[index + 3] & 0x1f);
            index += 3;
        } else {
            index += 1;
        }
    }
    types
}

/// Converts a length-prefixed (AVCC, 4-byte) parameter-set blob to Annex B;
/// an Annex B blob is returned unchanged.
fn annex_b(header: &[u8]) -> Vec<u8> {
    if header.starts_with(&[0, 0, 1]) || header.starts_with(&[0, 0, 0, 1]) {
        return header.to_vec();
    }
    let mut out = Vec::new();
    let mut rest = header;
    while rest.len() >= 4 {
        let length = u32::from_be_bytes([rest[0], rest[1], rest[2], rest[3]]) as usize;
        if length == 0 || rest.len() < 4 + length {
            break;
        }
        out.extend_from_slice(&[0, 0, 0, 1]);
        out.extend_from_slice(&rest[4..4 + length]);
        rest = &rest[4 + length..];
    }
    out
}

/// Makes a keyframe restartable: SPS and PPS before its IDR. A keyframe that
/// already carries both is unchanged.
pub fn ensure_parameter_sets(unit: Vec<u8>, parameter_sets: Option<&[u8]>) -> Vec<u8> {
    let types = nal_types(&unit);
    if types.contains(&7) && types.contains(&8) {
        return unit;
    }
    match parameter_sets.map(annex_b) {
        Some(header) if !header.is_empty() => [header, unit].concat(),
        _ => unit,
    }
}

/// Whether an Annex B keyframe carries a Baseline-compatible SPS (profile
/// 66, or 77/88/100 with constraint_set1 meaning Constrained Baseline
/// decodable) followed by PPS and IDR.
pub fn is_baseline_keyframe(unit: &[u8]) -> bool {
    let Some(sps) = unit.windows(4).position(|w| w[..3] == [0, 0, 1] && w[3] & 0x1f == 7) else { return false };
    let Some(&profile_idc) = unit.get(sps + 4) else { return false };
    let constraint = unit.get(sps + 5).copied().unwrap_or(0);
    let types = nal_types(unit);
    let ordered = matches!((types.iter().position(|t| *t == 7), types.iter().position(|t| *t == 8), types.iter().position(|t| *t == 5)),
        (Some(s), Some(p), Some(i)) if s < i && p < i);
    ordered && (profile_idc == 66 || constraint & 0x40 != 0)
}

/// What an encoder probe found.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProbeResult {
    pub encoder: Option<String>,
    pub hardware: bool,
    pub supports_720p: bool,
    pub supports_540p: bool,
}

impl ProbeResult {
    /// The H.264 profiles a probe result may advertise. A software encoder
    /// never advertises 720p without a measured qualification.
    pub fn profiles(&self) -> Vec<WatchLiveProfile> {
        let mut profiles = Vec::new();
        if self.hardware && self.supports_720p {
            profiles.push(WatchLiveProfile::H264_720p15);
        }
        if self.supports_540p || (self.hardware && self.supports_720p) {
            profiles.extend([WatchLiveProfile::H264_540p15, WatchLiveProfile::H264_540p10]);
        }
        profiles
    }
}

/// Shared between Core's handle and the encoder thread.
#[derive(Debug, Default)]
pub struct Control {
    pub stop: AtomicBool,
    pub keyframe: AtomicBool,
}

/// Runs one stream until stopped. Paces at the profile frame rate, drops
/// raw frames rather than queueing, and pushes access units into `sink`.
pub fn run_encoder_loop<S, E, F>(
    config: EncoderConfig,
    source: &mut S,
    mut make_encoder: F,
    sink: &EncodedChunkSink,
    control: &Control,
    protected: &dyn Fn() -> bool,
) where
    S: FrameSource,
    E: H264Encoder,
    F: FnMut(u32, u32) -> Result<E, &'static str>,
{
    let interval = config.frame_interval();
    let mut encoder: Option<(E, u32, u32)> = None;
    let mut last: Option<Bgra> = None;
    let mut frame_index: i64 = 0;
    let mut next_slot = Instant::now();
    let mut force_keyframe = true;
    while !control.stop.load(Ordering::Acquire) && !sink.is_closed() {
        let now = Instant::now();
        if now < next_slot {
            std::thread::sleep((next_slot - now).min(Duration::from_millis(20)));
            continue;
        }
        let late = now.duration_since(next_slot) > interval;
        next_slot = if late { now + interval } else { next_slot + interval };
        if late {
            sink.report(EncoderSample { missed_deadline: true, ..EncoderSample::default() });
        }
        if protected() {
            // Core stops the encoder too; never capture a protected screen.
            last = None;
            force_keyframe = true;
            continue;
        }
        let started = Instant::now();
        match source.next_frame(interval / 2) {
            Ok(Some(frame)) => last = Some(frame),
            Ok(None) => {}
            Err(reason) => {
                tracing::debug!(component = "live_stream", event = "capture_failed", reason);
                sink.report(EncoderSample { missed_deadline: true, ..EncoderSample::default() });
                continue;
            }
        }
        let Some(frame) = last.as_ref() else { continue };
        let Some((width, height)) =
            fit_encoder_dimensions(frame.width, frame.height, config.max_width, config.max_height)
        else {
            continue;
        };
        if encoder.as_ref().is_none_or(|(_, w, h)| (*w, *h) != (width, height)) {
            match make_encoder(width, height) {
                Ok(created) => encoder = Some((created, width, height)),
                Err(reason) => {
                    sink.failed(reason);
                    return;
                }
            }
            force_keyframe = true;
        }
        let Some(nv12) = bgra_to_nv12(frame, width, height) else { continue };
        let capture = started.elapsed();
        let keyframe = force_keyframe
            || control.keyframe.swap(false, Ordering::AcqRel)
            || sink.take_keyframe_request();
        force_keyframe = false;
        let timestamp_hns = frame_index * 10_000_000 / i64::from(config.fps.max(1));
        frame_index += 1;
        let (active, _, _) = encoder.as_mut().expect("created above");
        let encode_started = Instant::now();
        let units = match active.encode(&nv12, timestamp_hns, keyframe) {
            Ok(units) => units,
            Err(reason) => {
                sink.failed(reason);
                return;
            }
        };
        sink.report(EncoderSample { capture, encode: Some(encode_started.elapsed()), ..EncoderSample::default() });
        let parameter_sets = active.parameter_sets();
        for unit in units {
            let data = if unit.keyframe { ensure_parameter_sets(unit.data, parameter_sets.as_deref()) } else { unit.data };
            if !sink.push(EncodedVideoChunk {
                timestamp_micros: u64::try_from(unit.timestamp_hns / 10).unwrap_or(0),
                duration_micros: Some(interval.as_micros() as u32),
                width,
                height,
                keyframe: unit.keyframe,
                data,
            }) {
                force_keyframe = true;
            }
        }
    }
}

/// Core's handle. Dropping it stops the thread, which drops the encoder and
/// the capture session within one frame.
#[derive(Debug)]
pub struct WindowsLiveEncoder {
    control: Arc<Control>,
}

impl LiveEncoder for WindowsLiveEncoder {
    fn request_keyframe(&self) {
        self.control.keyframe.store(true, Ordering::Release);
    }
}

impl Drop for WindowsLiveEncoder {
    fn drop(&mut self) {
        self.control.stop.store(true, Ordering::Release);
    }
}

/// Starts the encoder thread for `config` on the player window.
pub fn start(
    window: usize,
    config: EncoderConfig,
    sink: EncodedChunkSink,
    protected: Box<dyn Fn() -> bool + Send>,
) -> Result<WindowsLiveEncoder, CaptureError> {
    if window == 0 {
        return Err(CaptureError::RendererNotReady);
    }
    let control = Arc::new(Control::default());
    let worker = Arc::clone(&control);
    std::thread::Builder::new()
        .name("watch-live-encoder".into())
        .spawn(move || platform::run(window, config, sink, &worker, protected.as_ref()))
        .map_err(|_| CaptureError::RendererUnavailable)?;
    Ok(WindowsLiveEncoder { control })
}

/// Probes the H.264 encoders once per process.
pub fn probe() -> &'static ProbeResult {
    static PROBE: std::sync::OnceLock<ProbeResult> = std::sync::OnceLock::new();
    PROBE.get_or_init(platform::probe)
}

#[cfg(not(windows))]
mod platform {
    use super::*;

    pub fn probe() -> ProbeResult {
        ProbeResult::default()
    }

    pub fn run(_: usize, _: EncoderConfig, sink: EncodedChunkSink, _: &Control, _: &dyn Fn() -> bool) {
        sink.failed("encoder_unavailable");
    }
}

#[cfg(windows)]
mod platform {
    use super::*;
    use crate::media_foundation::{MfH264Encoder, enumerate_encoders};

    pub fn probe() -> ProbeResult {
        let mut result = ProbeResult::default();
        let Ok(candidates) = enumerate_encoders() else { return result };
        for candidate in candidates {
            let try_size = |width: u32, height: u32| -> bool {
                let config = EncoderConfig::for_profile(WatchLiveProfile::H264_540p15);
                let Ok(mut encoder) = MfH264Encoder::new(&candidate, width, height, config.fps, config.target_bitrate)
                else {
                    return false;
                };
                let frame = Bgra { width, height, pixels: Arc::new(vec![96; (width * height * 4) as usize]) };
                let Some(nv12) = bgra_to_nv12(&frame, width, height) else { return false };
                for index in 0..6 {
                    let Ok(units) = encoder.encode(&nv12, index * 666_666, index == 0) else { return false };
                    if let Some(unit) = units.into_iter().find(|unit| unit.keyframe) {
                        let unit = ensure_parameter_sets(unit.data, encoder.parameter_sets().as_deref());
                        return is_baseline_keyframe(&unit) && unit.len() <= 512 * 1024;
                    }
                }
                false
            };
            let supports_720p = candidate.hardware && try_size(1280, 720);
            let supports_540p = supports_720p || try_size(960, 540);
            if supports_540p {
                result = ProbeResult {
                    encoder: Some(candidate.name.clone()),
                    hardware: candidate.hardware,
                    supports_720p,
                    supports_540p,
                };
                break;
            }
            tracing::info!(component = "live_stream", event = "encoder_rejected", encoder = %candidate.name);
        }
        tracing::info!(
            component = "live_stream",
            event = "encoder_probe",
            encoder = result.encoder.as_deref().unwrap_or("none"),
            hardware = result.hardware,
            profiles = result.profiles().len()
        );
        result
    }

    pub fn run(window: usize, config: EncoderConfig, sink: EncodedChunkSink, control: &Control, protected: &dyn Fn() -> bool) {
        let Ok(candidates) = enumerate_encoders() else {
            sink.failed("encoder_unavailable");
            return;
        };
        let Some(chosen) = probe().encoder.clone() else {
            sink.failed("encoder_unavailable");
            return;
        };
        let Some(candidate) = candidates.into_iter().find(|candidate| candidate.name == chosen) else {
            sink.failed("encoder_unavailable");
            return;
        };
        let mut source = match crate::win32::WindowCapture::open(window as *mut std::ffi::c_void) {
            Ok(source) => source,
            Err(reason) => {
                sink.failed(reason);
                return;
            }
        };
        run_encoder_loop(
            config,
            &mut source,
            |width, height| MfH264Encoder::new(&candidate, width, height, config.fps, config.target_bitrate),
            &sink,
            control,
            protected,
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_core::watch_live::SinkEvent;
    use std::sync::atomic::AtomicU64;

    const SPS_PPS: [u8; 16] = [0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce, 0x3c, 0x80];
    const IDR: [u8; 7] = [0, 0, 0, 1, 0x65, 0x88, 0x84];
    const DELTA: [u8; 6] = [0, 0, 1, 0x41, 0x88, 0xa0];

    fn solid(width: u32, height: u32, bgr: [u8; 3]) -> Bgra {
        let pixels = (0..width * height).flat_map(|_| [bgr[0], bgr[1], bgr[2], 255]).collect();
        Bgra { width, height, pixels: Arc::new(pixels) }
    }

    #[test]
    fn nv12_conversion_scales_and_uses_bt601_limited_range() {
        let white = bgra_to_nv12(&solid(1920, 1080, [255, 255, 255]), 960, 540).unwrap();
        assert_eq!(white.len(), 960 * 540 * 3 / 2);
        assert!(white[..960 * 540].iter().all(|&y| y == 235));
        assert!(white[960 * 540..].iter().all(|&c| c == 128));
        let red = bgra_to_nv12(&solid(64, 32, [0, 0, 255]), 32, 16).unwrap();
        assert_eq!((red[0], red[32 * 16], red[32 * 16 + 1]), (82, 90, 240));
        assert!(bgra_to_nv12(&solid(64, 32, [0, 0, 0]), 31, 16).is_none(), "4:2:0 needs even sizes");
        let truncated = Bgra { width: 4, height: 4, pixels: Arc::new(vec![0; 10]) };
        assert!(bgra_to_nv12(&truncated, 4, 4).is_none());
    }

    #[test]
    fn keyframes_get_parameter_sets_from_avcc_or_annex_b_headers() {
        let avcc = [&[0, 0, 0, 4][..], &[0x67, 0x42, 0xc0, 0x1f], &[0, 0, 0, 4], &[0x68, 0xce, 0x3c, 0x80]].concat();
        let fixed = ensure_parameter_sets(IDR.to_vec(), Some(&avcc));
        assert_eq!(fixed, [&SPS_PPS[..], &IDR[..]].concat());
        assert!(is_baseline_keyframe(&fixed));
        assert_eq!(ensure_parameter_sets(IDR.to_vec(), Some(&SPS_PPS)), fixed);
        assert_eq!(ensure_parameter_sets(fixed.clone(), Some(&SPS_PPS)), fixed, "already restartable");
        let high = [&[0, 0, 0, 1, 0x67, 100, 0, 0x1f][..], &SPS_PPS[8..], &IDR[..]].concat();
        assert!(!is_baseline_keyframe(&high), "High profile is not Baseline");
        assert!(!is_baseline_keyframe(&IDR), "an IDR without parameter sets");
    }

    #[test]
    fn capability_policy_follows_the_probe_not_the_platform() {
        assert!(ProbeResult::default().profiles().is_empty());
        let software = ProbeResult { supports_540p: true, supports_720p: true, ..ProbeResult::default() };
        assert_eq!(software.profiles(), [WatchLiveProfile::H264_540p15, WatchLiveProfile::H264_540p10]);
        let hardware = ProbeResult { hardware: true, supports_720p: true, supports_540p: true, ..ProbeResult::default() };
        assert_eq!(hardware.profiles()[0], WatchLiveProfile::H264_720p15);
        let weak = ProbeResult { hardware: true, supports_540p: true, ..ProbeResult::default() };
        assert_eq!(weak.profiles()[0], WatchLiveProfile::H264_540p15);
    }

    struct Source {
        frames: usize,
    }

    impl FrameSource for Source {
        fn next_frame(&mut self, _: Duration) -> Result<Option<Bgra>, &'static str> {
            self.frames += 1;
            // Every other call: nothing new; the loop reuses the last frame.
            Ok((self.frames % 2 == 1).then(|| solid(1920, 1080, [10, 20, 30])))
        }
    }

    struct Encoder {
        made: (u32, u32),
        forced: Arc<std::sync::Mutex<Vec<bool>>>,
    }

    impl H264Encoder for Encoder {
        fn encode(&mut self, nv12: &[u8], timestamp_hns: i64, force: bool) -> Result<Vec<EncodedUnit>, &'static str> {
            assert_eq!(nv12.len() as u32, self.made.0 * self.made.1 * 3 / 2);
            self.forced.lock().unwrap().push(force);
            let data = if force { IDR.to_vec() } else { DELTA.to_vec() };
            Ok(vec![EncodedUnit { data, keyframe: force, timestamp_hns }])
        }
        fn parameter_sets(&self) -> Option<Vec<u8>> {
            Some(SPS_PPS.to_vec())
        }
    }

    #[test]
    fn the_loop_encodes_paced_frames_and_stops_when_dropped() {
        let (sink, mut events) = EncodedChunkSink::new(Arc::new(AtomicU64::new(1)));
        let control = Arc::new(Control::default());
        let forced = Arc::new(std::sync::Mutex::new(Vec::new()));
        let config = EncoderConfig::for_profile(WatchLiveProfile::H264_540p15);
        let worker_control = Arc::clone(&control);
        let worker_forced = Arc::clone(&forced);
        let worker = std::thread::spawn(move || {
            let mut source = Source { frames: 0 };
            run_encoder_loop(
                config,
                &mut source,
                |width, height| Ok(Encoder { made: (width, height), forced: Arc::clone(&worker_forced) }),
                &sink,
                &worker_control,
                &|| false,
            );
        });
        let mut chunks = Vec::new();
        let deadline = Instant::now() + Duration::from_secs(5);
        while chunks.len() < 6 && Instant::now() < deadline {
            match events.try_recv() {
                Ok(SinkEvent::Chunk { chunk, .. }) => chunks.push(chunk),
                Ok(_) => {}
                Err(_) => std::thread::sleep(Duration::from_millis(5)),
            }
        }
        control.keyframe.store(true, Ordering::Release);
        std::thread::sleep(Duration::from_millis(200));
        drop(WindowsLiveEncoder { control: Arc::clone(&control) });
        worker.join().unwrap();
        assert!(chunks.len() >= 6, "{}", chunks.len());
        assert!(chunks[0].keyframe && is_baseline_keyframe(&chunks[0].data), "the stream starts restartable");
        assert!(chunks.iter().all(|chunk| (chunk.width, chunk.height) == (960, 540)));
        assert!(chunks.windows(2).all(|pair| pair[0].timestamp_micros < pair[1].timestamp_micros));
        let forced = forced.lock().unwrap();
        assert!(forced.iter().skip(1).any(|force| *force), "a keyframe request reached the encoder");
    }

    #[test]
    fn a_protected_screen_is_never_captured() {
        struct Panicking;
        impl FrameSource for Panicking {
            fn next_frame(&mut self, _: Duration) -> Result<Option<Bgra>, &'static str> {
                panic!("captured a protected screen");
            }
        }
        let (sink, _events) = EncodedChunkSink::new(Arc::new(AtomicU64::new(1)));
        let control = Arc::new(Control::default());
        let stopper = Arc::clone(&control);
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(300));
            stopper.stop.store(true, Ordering::Release);
        });
        run_encoder_loop::<_, Encoder, _>(
            EncoderConfig::for_profile(WatchLiveProfile::H264_540p15),
            &mut Panicking,
            |_, _| Err("unused"),
            &sink,
            &control,
            &|| true,
        );
    }
}
