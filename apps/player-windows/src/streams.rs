//! Bounded `IStream` implementations for WebView2 resource responses.
//!
//! Every byte the Runtime reads arrives through one of the read streams,
//! and neither can reach outside its verified region:
//!
//! * [`MemStream`] serves small packaged Runtime files from memory.
//! * [`FileRangeStream`] serves one byte range of one verified CAS object,
//!   reading only that region from the open file.
//!
//! Large video files are never loaded into RAM: the video element's range
//! requests each read only their own region.
//!
//! [`VecStream`] is the write direction: [`ICoreWebView2::CapturePreview`]
//! renders one PNG frame into it.
//!
//! The `IStream` implementations are COM glue, so this module shares
//! `win32`'s scoped `allow(unsafe_code)` under the workspace `deny`.
//! COM interface methods cannot be marked `unsafe` (the `implement`
//! signatures are fixed), so each raw-pointer dereference carries its
//! own justification instead. Constructors return the COM `IStream`
//! object rather than `Self` by design.
#![allow(unsafe_code)]
#![allow(clippy::not_unsafe_ptr_arg_deref)]
#![allow(clippy::new_ret_no_self)]

use std::io::{Read as _, Seek as _, SeekFrom};
use std::sync::{Arc, Mutex};
use windows::Win32::Foundation::{E_FAIL, E_INVALIDARG, E_NOTIMPL, S_FALSE, S_OK};
use windows::Win32::System::Com::{
    ISequentialStream_Impl, IStream, IStream_Impl, LOCKTYPE, STATFLAG, STATSTG, STGC, STGTY_STREAM, STREAM_SEEK,
    STREAM_SEEK_CUR, STREAM_SEEK_END, STREAM_SEEK_SET,
};
use windows::core::{HRESULT, Ref, implement};

/// In-memory stream for small packaged responses.
#[derive(Debug)]
#[implement(IStream)]
pub struct MemStream {
    data: Vec<u8>,
    position: Mutex<u64>,
}

impl MemStream {
    pub fn new(data: Vec<u8>) -> IStream {
        IStream::from(Self { data, position: Mutex::new(0) })
    }
}

impl ISequentialStream_Impl for MemStream_Impl {
    fn Read(&self, buffer: *mut core::ffi::c_void, bytes: u32, read: *mut u32) -> HRESULT {
        if buffer.is_null() {
            return E_INVALIDARG;
        }
        let mut position = self.position.lock().unwrap_or_else(|poison| poison.into_inner());
        let available = self.data.len().saturating_sub(*position as usize);
        let count = (bytes as usize).min(available);
        // SAFETY: WebView2 passes a valid `bytes`-byte buffer; `count`
        // never exceeds it or the data.
        unsafe {
            std::ptr::copy_nonoverlapping(self.data.as_ptr().add(*position as usize), buffer as *mut u8, count);
            if !read.is_null() {
                *read = count as u32;
            }
        }
        *position += count as u64;
        if count < bytes as usize { S_FALSE } else { S_OK }
    }

    fn Write(&self, _: *const core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for MemStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, position: *mut u64) -> windows::core::Result<()> {
        let mut current = self.position.lock().unwrap_or_else(|poison| poison.into_inner());
        let base: i64 = if origin == STREAM_SEEK_SET {
            0
        } else if origin == STREAM_SEEK_CUR {
            *current as i64
        } else if origin == STREAM_SEEK_END {
            self.data.len() as i64
        } else {
            return Err(E_INVALIDARG.into());
        };
        let next = base.saturating_add(offset).max(0).min(self.data.len() as i64) as u64;
        *current = next;
        if !position.is_null() {
            // SAFETY: WebView2 passes a valid out-pointer or null.
            unsafe {
                *position = next;
            }
        }
        Ok(())
    }

    fn Stat(&self, stat: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
        if stat.is_null() {
            return Err(E_INVALIDARG.into());
        }
        // SAFETY: WebView2 passes a valid out-structure; zeroing it leaves
        // no field uninitialized.
        unsafe {
            *stat = std::mem::zeroed();
            (*stat).r#type = STGTY_STREAM.0 as u32;
            (*stat).cbSize = self.data.len() as u64;
        }
        Ok(())
    }

    // The remaining IStream methods are never used for a response body:
    // fail them loudly rather than half-implementing them.
    fn SetSize(&self, _: u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn CopyTo(&self, _: Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// A bounded window over one verified file: reads serve `[base,
/// base+len)` and seeks clamp into it. The file was opened through the
/// secure opener and verified before the stream was built.
#[derive(Debug)]
#[implement(IStream)]
pub struct FileRangeStream {
    file: Mutex<std::fs::File>,
    base: u64,
    len: u64,
    position: Mutex<u64>,
}

impl FileRangeStream {
    pub fn new(file: std::fs::File, base: u64, len: u64) -> IStream {
        IStream::from(Self { file: Mutex::new(file), base, len, position: Mutex::new(0) })
    }
}

impl ISequentialStream_Impl for FileRangeStream_Impl {
    fn Read(&self, buffer: *mut core::ffi::c_void, bytes: u32, read: *mut u32) -> HRESULT {
        if buffer.is_null() {
            return E_INVALIDARG;
        }
        let mut position = self.position.lock().unwrap_or_else(|poison| poison.into_inner());
        let remaining = self.len.saturating_sub(*position);
        let count = (bytes as u64).min(remaining).min(u32::MAX as u64) as usize;
        if count == 0 {
            if !read.is_null() {
                // SAFETY: WebView2 passes a valid out-pointer or null.
                unsafe {
                    *read = 0;
                }
            }
            return S_FALSE;
        }
        let mut file = self.file.lock().unwrap_or_else(|poison| poison.into_inner());
        if file.seek(SeekFrom::Start(self.base + *position)).is_err() {
            return E_FAIL;
        }
        let mut taken = (&*file).take(count as u64);
        // SAFETY: WebView2 passes a valid `bytes`-byte buffer; the read
        // never exceeds `count`.
        let slice = unsafe { std::slice::from_raw_parts_mut(buffer as *mut u8, count) };
        let done = match taken.read(slice) {
            Ok(done) => done,
            Err(_) => return E_FAIL,
        };
        *position += done as u64;
        if !read.is_null() {
            // SAFETY: WebView2 passes a valid out-pointer or null.
            unsafe {
                *read = done as u32;
            }
        }
        if done < bytes as usize { S_FALSE } else { S_OK }
    }

    fn Write(&self, _: *const core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
        E_NOTIMPL
    }
}

impl IStream_Impl for FileRangeStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, position: *mut u64) -> windows::core::Result<()> {
        let mut current = self.position.lock().unwrap_or_else(|poison| poison.into_inner());
        let base: i64 = if origin == STREAM_SEEK_SET {
            0
        } else if origin == STREAM_SEEK_CUR {
            *current as i64
        } else if origin == STREAM_SEEK_END {
            self.len as i64
        } else {
            return Err(E_INVALIDARG.into());
        };
        let next = base.saturating_add(offset).max(0).min(self.len as i64) as u64;
        *current = next;
        if !position.is_null() {
            // SAFETY: WebView2 passes a valid out-pointer or null.
            unsafe {
                *position = next;
            }
        }
        Ok(())
    }

    fn Stat(&self, stat: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
        if stat.is_null() {
            return Err(E_INVALIDARG.into());
        }
        // SAFETY: WebView2 passes a valid out-structure; zeroing it leaves
        // no field uninitialized.
        unsafe {
            *stat = std::mem::zeroed();
            (*stat).r#type = STGTY_STREAM.0 as u32;
            (*stat).cbSize = self.len;
        }
        Ok(())
    }

    fn SetSize(&self, _: u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn CopyTo(&self, _: Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// A bounded in-memory write sink: `CapturePreview` renders one PNG
/// frame through `Write`, and the completion handler takes the bytes
/// from the shared buffer. The buffer never grows past
/// [`VecStream::MAX_BYTES`]; a frame that would exceed it fails the
/// write rather than the process.
#[derive(Debug)]
#[implement(IStream)]
pub struct VecStream {
    data: Arc<Mutex<Vec<u8>>>,
    position: Mutex<u64>,
}

impl VecStream {
    /// 32 MiB: far above any single viewport PNG, far below memory harm.
    pub const MAX_BYTES: usize = 32 * 1024 * 1024;

    pub fn new() -> (IStream, Arc<Mutex<Vec<u8>>>) {
        let data = Arc::new(Mutex::new(Vec::new()));
        let stream = IStream::from(Self { data: Arc::clone(&data), position: Mutex::new(0) });
        (stream, data)
    }
}

impl ISequentialStream_Impl for VecStream_Impl {
    fn Read(&self, _: *mut core::ffi::c_void, _: u32, _: *mut u32) -> HRESULT {
        E_NOTIMPL
    }

    fn Write(&self, buffer: *const core::ffi::c_void, bytes: u32, written: *mut u32) -> HRESULT {
        if buffer.is_null() {
            return E_INVALIDARG;
        }
        let mut data = self.data.lock().unwrap_or_else(|poison| poison.into_inner());
        let mut position = self.position.lock().unwrap_or_else(|poison| poison.into_inner());
        let start = (*position as usize).min(data.len());
        let end = start.saturating_add(bytes as usize);
        if end > VecStream::MAX_BYTES {
            return E_FAIL;
        }
        if data.len() < end {
            data.resize(end, 0);
        }
        // SAFETY: WebView2 passes a valid `bytes`-byte buffer; the
        // resized region is exactly where it lands.
        unsafe {
            std::ptr::copy_nonoverlapping(buffer as *const u8, data.as_mut_ptr().add(start), bytes as usize);
            if !written.is_null() {
                *written = bytes;
            }
        }
        *position = end as u64;
        S_OK
    }
}

impl IStream_Impl for VecStream_Impl {
    fn Seek(&self, offset: i64, origin: STREAM_SEEK, position: *mut u64) -> windows::core::Result<()> {
        let data = self.data.lock().unwrap_or_else(|poison| poison.into_inner());
        let mut current = self.position.lock().unwrap_or_else(|poison| poison.into_inner());
        let base: i64 = if origin == STREAM_SEEK_SET {
            0
        } else if origin == STREAM_SEEK_CUR {
            *current as i64
        } else if origin == STREAM_SEEK_END {
            data.len() as i64
        } else {
            return Err(E_INVALIDARG.into());
        };
        let next = base.saturating_add(offset).max(0).min(data.len() as i64) as u64;
        *current = next;
        if !position.is_null() {
            // SAFETY: WebView2 passes a valid out-pointer or null.
            unsafe {
                *position = next;
            }
        }
        Ok(())
    }

    fn Stat(&self, stat: *mut STATSTG, _: &STATFLAG) -> windows::core::Result<()> {
        if stat.is_null() {
            return Err(E_INVALIDARG.into());
        }
        let data = self.data.lock().unwrap_or_else(|poison| poison.into_inner());
        // SAFETY: WebView2 passes a valid out-structure; zeroing it leaves
        // no field uninitialized.
        unsafe {
            *stat = std::mem::zeroed();
            (*stat).r#type = STGTY_STREAM.0 as u32;
            (*stat).cbSize = data.len() as u64;
        }
        Ok(())
    }

    fn SetSize(&self, size: u64) -> windows::core::Result<()> {
        let mut data = self.data.lock().unwrap_or_else(|poison| poison.into_inner());
        let size = size as usize;
        if size > VecStream::MAX_BYTES {
            return Err(E_FAIL.into());
        }
        data.resize(size, 0);
        Ok(())
    }

    fn CopyTo(&self, _: Ref<IStream>, _: u64, _: *mut u64, _: *mut u64) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Commit(&self, _: &STGC) -> windows::core::Result<()> {
        Ok(())
    }

    fn Revert(&self) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn LockRegion(&self, _: u64, _: u64, _: &LOCKTYPE) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn UnlockRegion(&self, _: u64, _: u64, _: u32) -> windows::core::Result<()> {
        Err(E_NOTIMPL.into())
    }

    fn Clone(&self) -> windows::core::Result<IStream> {
        Err(E_NOTIMPL.into())
    }
}

/// Shared ownership helper for handler closures.
pub type Shared<T> = Arc<Mutex<T>>;
