//! Bounded legacy host imports and non-null Package API 4 call framing.
use serde::{Serialize, de::DeserializeOwned};

pub const INPUT_ADDRESS: u32 = 32 * 1024;
pub const OUTPUT_ADDRESS: u32 = 16 * 1024;
pub const FRAME_BYTES: usize = 16 * 1024;
pub const MAX_KV_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IoError {
    Missing,
    Denied,
    TooLarge,
    Failed,
    Invalid,
}
#[link(wasm_import_module = "tilecast")]
unsafe extern "C" {
    fn kv_get(key_ptr: u32, key_len: u32, out_ptr: u32, out_cap: u32) -> i32;
    fn kv_set(key_ptr: u32, key_len: u32, value_ptr: u32, value_len: u32) -> i32;
    fn http_fetch(url_ptr: u32, url_len: u32, out_ptr: u32, out_cap: u32) -> i32;
    fn now_ms() -> u64;
}

fn code(value: i32) -> IoError {
    match value {
        -1 | -5 => IoError::Denied,
        -2 => IoError::Missing,
        -3 => IoError::TooLarge,
        _ => IoError::Failed,
    }
}
fn answer(mut output: Vec<u8>, written: i32) -> Result<Vec<u8>, IoError> {
    if written < 0 {
        return Err(code(written));
    }
    let written = written as usize;
    if written > output.capacity() {
        return Err(IoError::Invalid);
    }
    // SAFETY: each import writes its returned length within this allocation.
    unsafe {
        output.set_len(written);
    }
    Ok(output)
}
pub fn get(key: &str) -> Result<Option<Vec<u8>>, IoError> {
    if key.is_empty() || key.len() > 128 {
        return Err(IoError::Invalid);
    }
    let mut out = Vec::with_capacity(MAX_KV_BYTES);
    // SAFETY: both allocations remain live for the synchronous bounded import.
    let written =
        unsafe { kv_get(key.as_ptr() as u32, key.len() as u32, out.as_mut_ptr() as u32, MAX_KV_BYTES as u32) };
    if written == -2 {
        return Ok(None);
    }
    answer(out, written).map(Some)
}
pub fn set(key: &str, value: &[u8]) -> Result<(), IoError> {
    if key.is_empty() || key.len() > 128 || value.len() > MAX_KV_BYTES {
        return Err(IoError::TooLarge);
    }
    // SAFETY: borrowed input slices outlive the synchronous import.
    let result = unsafe { kv_set(key.as_ptr() as u32, key.len() as u32, value.as_ptr() as u32, value.len() as u32) };
    if result == 0 { Ok(()) } else { Err(code(result)) }
}
pub fn fetch(url: &str, max_bytes: usize) -> Result<Vec<u8>, IoError> {
    if url.is_empty() || url.len() > 2048 || max_bytes == 0 || max_bytes > 1 << 20 {
        return Err(IoError::TooLarge);
    }
    let mut out = Vec::with_capacity(max_bytes);
    // SAFETY: borrowed URL and writable output capacity outlive this import.
    let written =
        unsafe { http_fetch(url.as_ptr() as u32, url.len() as u32, out.as_mut_ptr() as u32, max_bytes as u32) };
    answer(out, written)
}
pub fn wall_now_ms() -> u64 {
    // SAFETY: the import takes no pointer and returns the host wall time.
    unsafe { now_ms() }
}

/// Decode an owned Studio request from the host's reserved non-null window.
///
/// # Safety
/// The caller must be a wasm32 guest export invoked by the Package API 4 host.
/// The input window must be readable and unchanged for this call.
pub unsafe fn read_request<T: DeserializeOwned>(ptr: u32, len: u32) -> Result<T, IoError> {
    if ptr != INPUT_ADDRESS || len as usize > FRAME_BYTES {
        return Err(IoError::Invalid);
    }
    // SAFETY: validated non-null reserved window and the export caller's contract.
    let raw = unsafe { std::slice::from_raw_parts(ptr as *const u8, len as usize) };
    serde_json::from_slice(raw).map_err(|_| IoError::Invalid)
}

/// Write one bounded JSON Studio answer to the host's output window.
///
/// # Safety
/// The caller must be a wasm32 guest export invoked by the Package API 4 host.
/// The reserved output window must be writable and not alias `value`.
pub unsafe fn write_answer<T: Serialize>(ptr: u32, cap: u32, value: &T) -> Result<i32, IoError> {
    if ptr != OUTPUT_ADDRESS || cap as usize > FRAME_BYTES {
        return Err(IoError::Invalid);
    }
    let raw = serde_json::to_vec(value).map_err(|_| IoError::Invalid)?;
    if raw.len() > cap as usize {
        return Err(IoError::TooLarge);
    }
    // SAFETY: separate reserved host output window, bounded by its declared capacity.
    unsafe {
        std::ptr::copy_nonoverlapping(raw.as_ptr(), ptr as *mut u8, raw.len());
    }
    Ok(raw.len() as i32)
}
