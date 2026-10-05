//! Final-output capture: Studio preview and Watch Live see what the
//! compositor shows, not a reconstructed scene. One capture is in flight
//! across both callers; protected states never produce an image.
//!
//! The backend is Windows Graphics Capture of the player's own window,
//! which the compositor renders without a picker, consent UI, or border.
//! Frames come back as BGRA pixels and leave as bounded JPEGs.

use std::sync::atomic::Ordering;
use std::time::Duration;

use player_core::{CaptureError, CapturedFrame, RendererCaptureRequest};

use crate::daemon::DaemonContext;

/// How long the compositor gets to produce one frame.
pub const FRAME_WAIT: Duration = player_core::RENDERER_CAPTURE_TIMEOUT;
/// The whole blocking capture (device setup plus one frame) never runs
/// longer than this; Core does not time the host out.
const CAPTURE_TIMEOUT: Duration = Duration::from_secs(30);
/// JPEG quality ladder, best first.
const QUALITIES: [u8; 4] = [85, 70, 55, 40];
/// Each shrink round scales dimensions by this much.
const SHRINK: f64 = 0.75;
/// Shrinking stops here: below this a preview says nothing.
const MIN_WIDTH: u32 = 160;
const MIN_HEIGHT: u32 = 90;

/// One fair capture slot across preview and Watch Live. Results never
/// enter durable state.
#[derive(Debug, Default)]
pub struct CaptureBroker {
    slot: tokio::sync::Mutex<()>,
}

impl CaptureBroker {
    pub fn new() -> Self {
        Self::default()
    }

    pub async fn capture_frame(
        &self,
        context: &DaemonContext,
        max_width: u32,
        max_height: u32,
        max_bytes: u32,
    ) -> Result<CapturedFrame, CaptureError> {
        let _slot = self.slot.lock().await;
        {
            let engine = context.presentation.lock().unwrap_or_else(|poison| poison.into_inner());
            let Some(active) = engine.current() else {
                return Err(CaptureError::NothingShown);
            };
            active.renderer_metadata.capture_state.check(false)?;
        }
        let raw = context.main_window.load(Ordering::Acquire);
        if raw == 0 {
            return Err(CaptureError::RendererNotReady);
        }
        // The window address crosses threads as an integer (`usize` is
        // `Send`; a raw pointer is not). The UI thread owns the window for
        // longer than any capture runs: it publishes the address when the
        // window opens and clears it only after the loop ends.
        let captured = tokio::time::timeout(CAPTURE_TIMEOUT, async move {
            tokio::task::spawn_blocking(move || {
                crate::win32::capture_window_bgra(raw as *mut std::ffi::c_void, FRAME_WAIT)
            })
            .await
        })
        .await
        .map_err(|_| CaptureError::RendererTimeout)?
        .map_err(|_| CaptureError::RendererUnavailable)?
        .map_err(|code| match code {
            "no_frame" => CaptureError::RendererTimeout,
            "readback" => CaptureError::Invalid,
            _ => CaptureError::RendererUnavailable,
        })?;
        let request = RendererCaptureRequest { request_id: uuid::Uuid::new_v4(), max_width, max_height, max_bytes };
        let (jpeg, width, height) =
            encode_jpeg_fit(&captured, max_width, max_height, max_bytes).ok_or(CaptureError::Invalid)?;
        CapturedFrame::new(request, jpeg, width, height).map_err(|error| match error {
            player_core::RendererPortError::CaptureOutOfBounds => CaptureError::OutOfBounds,
            _ => CaptureError::Invalid,
        })
    }
}

/// `true` when the active presentation must never be captured (setup,
/// pairing, safe mode, or nothing shown).
pub fn presentation_protected(context: &DaemonContext) -> bool {
    context
        .presentation
        .lock()
        .unwrap_or_else(|poison| poison.into_inner())
        .current()
        .is_some_and(|active| active.renderer_metadata.capture_state.check(false).is_err())
}

/// Scales a BGRA frame into the requested bounds (never up) and encodes
/// the smallest JPEG that fits the byte budget: the quality ladder first,
/// then smaller dimensions. `None` means no honest frame fits.
pub fn encode_jpeg_fit(
    frame: &crate::win32::CapturedBgra,
    max_width: u32,
    max_height: u32,
    max_bytes: u32,
) -> Option<(Vec<u8>, u32, u32)> {
    if frame.width == 0 || frame.height == 0 || max_width == 0 || max_height == 0 {
        return None;
    }
    let pixels = u64::from(frame.width) * u64::from(frame.height) * 4;
    if frame.pixels.len() as u64 != pixels {
        return None;
    }
    let scale =
        (f64::from(max_width) / f64::from(frame.width)).min(f64::from(max_height) / f64::from(frame.height)).min(1.0);
    let (mut width, mut height) = (
        (f64::from(frame.width) * scale).floor().max(1.0) as u32,
        (f64::from(frame.height) * scale).floor().max(1.0) as u32,
    );
    let rgb: Vec<u8> = frame.pixels.as_chunks::<4>().0.iter().flat_map(|bgra| [bgra[2], bgra[1], bgra[0]]).collect();
    loop {
        let full = image::RgbImage::from_raw(frame.width, frame.height, rgb.clone())?;
        let scaled = image::imageops::resize(&full, width, height, image::imageops::FilterType::Triangle);
        for quality in QUALITIES {
            let mut jpeg = Vec::new();
            let mut encoder = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpeg, quality);
            encoder.encode(scaled.as_raw(), width, height, image::ExtendedColorType::Rgb8).ok()?;
            if jpeg.len() as u64 <= u64::from(max_bytes) {
                return Some((jpeg, width, height));
            }
        }
        if width <= MIN_WIDTH && height <= MIN_HEIGHT {
            return None;
        }
        width = ((f64::from(width) * SHRINK).floor().max(1.0) as u32).max(1);
        height = ((f64::from(height) * SHRINK).floor().max(1.0) as u32).max(1);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn gradient(width: u32, height: u32) -> crate::win32::CapturedBgra {
        let mut pixels = Vec::with_capacity(width as usize * height as usize * 4);
        for y in 0..height {
            for x in 0..width {
                pixels.extend_from_slice(&[(x % 256) as u8, (y % 256) as u8, ((x + y) % 256) as u8, 255]);
            }
        }
        crate::win32::CapturedBgra { width, height, pixels }
    }

    #[test]
    fn encodes_fit_bounded_jpegs() {
        let frame = gradient(1920, 1080);
        let (jpeg, width, height) = encode_jpeg_fit(&frame, 960, 540, 256 * 1024).expect("fits");
        assert_eq!((width, height), (960, 540));
        assert!(jpeg.starts_with(&[0xff, 0xd8]));
        assert!(jpeg.len() <= 256 * 1024);
    }

    #[test]
    fn never_upscales() {
        let frame = gradient(320, 240);
        let (_, width, height) = encode_jpeg_fit(&frame, 960, 540, 256 * 1024).expect("fits");
        assert_eq!((width, height), (320, 240));
    }

    #[test]
    fn tight_budgets_shrink_then_give_up() {
        let frame = gradient(1920, 1080);
        let small = encode_jpeg_fit(&frame, 960, 540, 8 * 1024).expect("shrinks to fit");
        assert!(small.0.len() <= 8 * 1024);
        assert!(small.1 <= 960 && small.2 <= 540);
        assert!(encode_jpeg_fit(&frame, 960, 540, 100).is_none());
    }

    #[test]
    fn corrupt_frames_are_refused() {
        let frame = crate::win32::CapturedBgra { width: 64, height: 64, pixels: vec![0u8; 100] };
        assert!(encode_jpeg_fit(&frame, 960, 540, 256 * 1024).is_none());
        let empty = crate::win32::CapturedBgra { width: 0, height: 0, pixels: Vec::new() };
        assert!(encode_jpeg_fit(&empty, 960, 540, 256 * 1024).is_none());
        let frame = gradient(64, 64);
        assert!(encode_jpeg_fit(&frame, 0, 540, 256 * 1024).is_none());
    }

    #[test]
    fn encoded_frames_satisfy_core_bounds() {
        let frame = gradient(1280, 720);
        let (jpeg, width, height) = encode_jpeg_fit(&frame, 960, 540, 256 * 1024).expect("fits");
        let request = RendererCaptureRequest {
            request_id: uuid::Uuid::new_v4(),
            max_width: 960,
            max_height: 540,
            max_bytes: 256 * 1024,
        };
        let captured = CapturedFrame::new(request, jpeg, width, height).expect("core accepts");
        assert_eq!(captured.dimensions(), (width, height));
    }
}
