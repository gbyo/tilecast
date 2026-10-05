//! The only raw Windows API surface in the player. Every `unsafe` call in
//! this file carries the contract that makes it sound.
//!
//! [`allow(unsafe_code)`] is scoped to this module, plus the WebView2 COM
//! glue in the UI thread (`ui`'s Windows implementation) and `streams`,
//! which cannot live anywhere but its STA thread and follow the same
//! one-justification-per-call rule. The workspace denies `unsafe_code`;
//! nothing outside those three modules may use it.
#![allow(unsafe_code)]

#[cfg(windows)]
mod imp {
    use std::os::windows::ffi::OsStrExt as _;
    use std::path::{Path, PathBuf};

    use windows::Win32::Foundation::{ERROR_MORE_DATA, ERROR_SUCCESS, HLOCAL, LocalFree, MAX_PATH};
    use windows::Win32::Globalization::GetUserDefaultLocaleName;
    use windows::Win32::Security::Cryptography::{
        CRYPT_INTEGER_BLOB, CRYPTPROTECT_UI_FORBIDDEN, CryptProtectData, CryptUnprotectData,
    };
    use windows::Win32::Storage::FileSystem::GetDiskFreeSpaceExW;
    use windows::Win32::System::Com::CoTaskMemFree;
    use windows::Win32::System::Registry::{
        HKEY_LOCAL_MACHINE, KEY_READ, REG_SZ, RegCloseKey, RegOpenKeyExW, RegQueryValueExW,
    };
    use windows::Win32::System::SystemInformation::GetTickCount64;
    use windows::Win32::UI::Shell::{FOLDERID_LocalAppData, KF_FLAG_DEFAULT, SHGetKnownFolderPath};
    use windows::core::{HSTRING, PCWSTR, PWSTR};

    /// A CoTaskMem string that frees itself.
    struct CoTaskMemString(PWSTR);

    impl Drop for CoTaskMemString {
        fn drop(&mut self) {
            if !self.0.is_null() {
                // SAFETY: the pointer came from a shell allocation call and is
                // freed exactly once, here, with the matching allocator.
                unsafe {
                    CoTaskMemFree(Some(self.0.as_ptr() as *const _));
                }
            }
        }
    }

    /// The current user's LocalAppData directory.
    pub fn local_app_data() -> Option<PathBuf> {
        // SAFETY: the folder id is a valid constant; the call allocates a
        // CoTaskMem string the guard frees exactly once.
        let path = unsafe { SHGetKnownFolderPath(&FOLDERID_LocalAppData, KF_FLAG_DEFAULT, None) }.ok()?;
        let _guard = CoTaskMemString(path);
        if path.is_null() {
            return None;
        }
        // SAFETY: `path` is a valid null-terminated UTF-16 string until the
        // guard drops.
        let text = unsafe { path.to_string() }.ok()?;
        let directory = PathBuf::from(text);
        directory.is_absolute().then_some(directory)
    }

    /// Encrypts `plaintext` with user-scoped DPAPI: only this Windows user on
    /// this machine can decrypt it. `CRYPTPROTECT_UI_FORBIDDEN` keeps a
    /// compromised prompt from ever appearing on signage.
    pub fn protect_user_data(plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(plaintext.len()).map_err(std::io::Error::other)?,
            pbData: plaintext.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: `input` borrows live bytes; `output` receives a LocalAlloc
        // buffer that is freed exactly once below. No optional entropy,
        // description, or prompt.
        unsafe { CryptProtectData(&input, PCWSTR::null(), None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
            .map_err(std::io::Error::from)?;
        // SAFETY: `output` is a valid `cbData`-byte buffer until freed.
        let sealed = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        // SAFETY: `output.pbData` came from CryptProtectData.
        unsafe {
            LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        }
        Ok(sealed)
    }

    /// Decrypts a blob from [`protect_user_data`].
    pub fn unprotect_user_data(sealed: &[u8]) -> std::io::Result<Vec<u8>> {
        let input = CRYPT_INTEGER_BLOB {
            cbData: u32::try_from(sealed.len()).map_err(std::io::Error::other)?,
            pbData: sealed.as_ptr() as *mut u8,
        };
        let mut output = CRYPT_INTEGER_BLOB::default();
        // SAFETY: as in `protect_user_data`.
        unsafe { CryptUnprotectData(&input, None, None, None, None, CRYPTPROTECT_UI_FORBIDDEN, &mut output) }
            .map_err(std::io::Error::from)?;
        // SAFETY: as in `protect_user_data`.
        let plaintext = unsafe { std::slice::from_raw_parts(output.pbData, output.cbData as usize).to_vec() };
        // SAFETY: as in `protect_user_data`.
        unsafe {
            LocalFree(Some(HLOCAL(output.pbData as *mut _)));
        }
        Ok(plaintext)
    }

    /// Bytes available to the caller on the volume holding `path`.
    pub fn available_bytes(path: &Path) -> std::io::Result<u64> {
        let wide: Vec<u16> = path.as_os_str().encode_wide().chain(std::iter::once(0)).collect();
        let mut free: u64 = 0;
        // SAFETY: `wide` is null-terminated and outlives the call; `free`
        // is a valid out-parameter.
        unsafe { GetDiskFreeSpaceExW(PCWSTR(wide.as_ptr()), None, None, Some(&mut free)) }
            .map_err(std::io::Error::from)?;
        Ok(free)
    }

    /// Milliseconds since boot (wraps only after hundreds of millions of years).
    pub fn tick_count_ms() -> Option<u64> {
        // SAFETY: no arguments, no failure mode.
        Some(unsafe { GetTickCount64() })
    }

    /// Reads a `REG_SZ` string from `HKLM\<subkey>\<value>`.
    pub fn machine_registry_string(subkey: &str, value: &str) -> Option<String> {
        let subkey = HSTRING::from(subkey);
        let value = HSTRING::from(value);
        let mut key = windows::Win32::System::Registry::HKEY::default();
        // SAFETY: string arguments are valid HSTRINGs; `key` receives the
        // opened handle, closed exactly once below.
        if unsafe { RegOpenKeyExW(HKEY_LOCAL_MACHINE, PCWSTR(subkey.as_ptr()), None, KEY_READ, &mut key) }
            != ERROR_SUCCESS
        {
            return None;
        }
        struct Guard(windows::Win32::System::Registry::HKEY);
        impl Drop for Guard {
            fn drop(&mut self) {
                // SAFETY: the handle is open and closed exactly once.
                unsafe {
                    let _ = RegCloseKey(self.0);
                }
            }
        }
        let _guard = Guard(key);
        let mut kind = REG_SZ;
        let mut size: u32 = 0;
        // SAFETY: querying the size first; no buffer is written.
        let status =
            unsafe { RegQueryValueExW(key, PCWSTR(value.as_ptr()), None, Some(&mut kind), None, Some(&mut size)) };
        if status != ERROR_SUCCESS && status != ERROR_MORE_DATA {
            return None;
        }
        if kind != REG_SZ || size == 0 || size > 1 << 16 {
            return None;
        }
        let mut buffer = vec![0u16; size as usize / 2 + 1];
        // SAFETY: `buffer` has room for `size` bytes; the length is
        // re-checked before it is read.
        let status = unsafe {
            RegQueryValueExW(
                key,
                PCWSTR(value.as_ptr()),
                None,
                Some(&mut kind),
                Some(buffer.as_mut_ptr() as *mut u8),
                Some(&mut size),
            )
        };
        if status != ERROR_SUCCESS || kind != REG_SZ {
            return None;
        }
        let chars = size as usize / 2;
        if chars > buffer.len() {
            return None;
        }
        String::from_utf16(&buffer[..chars]).ok().map(|text| text.trim_end_matches('\0').to_owned())
    }

    /// The user's default locale name (`en-US`), for pairing metadata.
    pub fn user_locale_name() -> Option<String> {
        let mut buffer = [0u16; MAX_PATH as usize];
        // SAFETY: `buffer` is a valid out-parameter of its own length.
        let written = unsafe { GetUserDefaultLocaleName(&mut buffer) };
        if written <= 0 || written as usize > buffer.len() {
            return None;
        }
        String::from_utf16(&buffer[..written as usize - 1]).ok()
    }

    /// The OS build number from the registry (`CurrentBuild`), for pairing
    /// metadata. The version APIs lie without an embedded manifest; the
    /// registry does not.
    pub fn os_build_number() -> Option<String> {
        machine_registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "CurrentBuild")
    }

    /// The OS product name from the registry (`ProductName`).
    pub fn os_product_name() -> Option<String> {
        machine_registry_string(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion", "ProductName")
    }

    /// The window class of remote web child windows. Plain children of
    /// the main window; WebView2 controllers parent to them.
    const REMOTE_CLASS: &[u16] = &[
        b'T' as u16,
        b'i' as u16,
        b'l' as u16,
        b'e' as u16,
        b'c' as u16,
        b'a' as u16,
        b's' as u16,
        b't' as u16,
        b'R' as u16,
        b'e' as u16,
        b'm' as u16,
        b'o' as u16,
        b't' as u16,
        b'e' as u16,
        b'V' as u16,
        b'i' as u16,
        b'e' as u16,
        b'w' as u16,
        0,
    ];

    unsafe extern "system" fn remote_wndproc(
        window: windows::Win32::Foundation::HWND,
        message: u32,
        wparam: windows::Win32::Foundation::WPARAM,
        lparam: windows::Win32::Foundation::LPARAM,
    ) -> windows::Win32::Foundation::LRESULT {
        // SAFETY: the default handler for a plain child window; every
        // parameter comes from the system dispatcher.
        unsafe { windows::Win32::UI::WindowsAndMessaging::DefWindowProcW(window, message, wparam, lparam) }
    }

    /// Registers the remote child window class once. Called on the UI
    /// thread before the first remote surface is created.
    pub fn register_remote_class() -> bool {
        use windows::Win32::Foundation::HINSTANCE;
        use windows::Win32::UI::WindowsAndMessaging::{CS_HREDRAW, CS_VREDRAW, RegisterClassW, WNDCLASSW};
        static REGISTERED: std::sync::OnceLock<bool> = std::sync::OnceLock::new();
        *REGISTERED.get_or_init(|| {
            let class = WNDCLASSW {
                style: CS_HREDRAW | CS_VREDRAW,
                lpfnWndProc: Some(remote_wndproc),
                hInstance: HINSTANCE::default(),
                lpszClassName: windows::core::PCWSTR(REMOTE_CLASS.as_ptr()),
                ..Default::default()
            };
            // SAFETY: the class name is a valid null-terminated UTF-16
            // string that lives for the process; the window procedure is
            // a plain default handler.
            unsafe { RegisterClassW(&class) != 0 }
        })
    }

    /// Creates a remote web child window at device pixels. The caller
    /// owns the handle and destroys it; all calls stay on the UI thread.
    pub fn create_remote_child(
        parent: *mut std::ffi::c_void,
        x: i32,
        y: i32,
        width: i32,
        height: i32,
        visible: bool,
    ) -> Option<*mut std::ffi::c_void> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{
            CreateWindowExW, WINDOW_EX_STYLE, WS_CHILD, WS_CLIPSIBLINGS, WS_VISIBLE,
        };
        let mut style = WS_CHILD | WS_CLIPSIBLINGS;
        if visible {
            style |= WS_VISIBLE;
        }
        // SAFETY: `parent` is the UI thread's live main window; the class
        // was registered by `register_remote_class`; coordinates are
        // validated device pixels.
        let child = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE(0),
                windows::core::PCWSTR(REMOTE_CLASS.as_ptr()),
                windows::core::PCWSTR::null(),
                style,
                x,
                y,
                width,
                height,
                Some(HWND(parent)),
                None,
                None,
                None,
            )
        };
        match child {
            Ok(child) => (!child.is_invalid()).then_some(child.0),
            Err(_) => None,
        }
    }

    /// Moves a remote child window to device pixels.
    pub fn move_remote_child(child: *mut std::ffi::c_void, x: i32, y: i32, width: i32, height: i32) {
        use windows::Win32::Foundation::HWND;
        // SAFETY: `child` is a live remote child window on this thread.
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::MoveWindow(HWND(child), x, y, width, height, true);
        }
    }

    /// Shows or hides a remote child window.
    pub fn show_remote_child(child: *mut std::ffi::c_void, visible: bool) {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::UI::WindowsAndMessaging::{SW_HIDE, SW_SHOWNA};
        // SAFETY: `child` is a live remote child window on this thread;
        // showing never activates (signage takes no focus).
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::ShowWindow(
                HWND(child),
                if visible { SW_SHOWNA } else { SW_HIDE },
            );
        }
    }

    /// Destroys a remote child window. Its WebView2 controller must
    /// already be closed.
    pub fn destroy_remote_child(child: *mut std::ffi::c_void) {
        use windows::Win32::Foundation::HWND;
        // SAFETY: `child` is a live remote child window on this thread.
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::DestroyWindow(HWND(child));
        }
    }

    /// Starts a repeating UI-thread timer that posts `WM_TIMER` with the
    /// given id. The YouTube state poll is the only user.
    pub fn start_poll_timer(window: *mut std::ffi::c_void, id: usize, interval_ms: u32) -> bool {
        use windows::Win32::Foundation::HWND;
        // SAFETY: `window` is the UI thread's live main window; a null
        // callback posts `WM_TIMER` to its queue.
        unsafe { windows::Win32::UI::WindowsAndMessaging::SetTimer(Some(HWND(window)), id, interval_ms, None) != 0 }
    }

    /// Stops a UI-thread timer started by [`start_poll_timer`].
    pub fn stop_poll_timer(window: *mut std::ffi::c_void, id: usize) {
        use windows::Win32::Foundation::HWND;
        // SAFETY: `window` is the UI thread's live main window.
        unsafe {
            let _ = windows::Win32::UI::WindowsAndMessaging::KillTimer(Some(HWND(window)), id);
        }
    }

    /// The single-instance mutex name. One player per login session,
    /// whatever the version or working directory.
    pub const SINGLE_INSTANCE_MUTEX: &str = r"Local\TilecastPlayerSingleInstance";

    /// Holds the process-wide single-instance mutex. Dropping releases
    /// the claim; the handle lives for the process.
    #[derive(Debug)]
    pub struct InstanceGuard {
        handle: windows::Win32::Foundation::HANDLE,
    }

    impl Drop for InstanceGuard {
        fn drop(&mut self) {
            // SAFETY: the handle came from `CreateMutexW` and closes
            // exactly once, here.
            unsafe {
                let _ = windows::Win32::Foundation::CloseHandle(self.handle);
            }
        }
    }

    /// Claims the single instance. `None` means another player already
    /// runs in this session; the caller exits without touching state.
    pub fn claim_single_instance() -> Option<InstanceGuard> {
        use windows::Win32::Foundation::{ERROR_ALREADY_EXISTS, GetLastError};
        let mut name: Vec<u16> = SINGLE_INSTANCE_MUTEX.encode_utf16().chain(std::iter::once(0)).collect();
        // SAFETY: the name is a valid null-terminated UTF-16 string; the
        // security argument is default.
        let handle = unsafe {
            windows::Win32::System::Threading::CreateMutexW(None, true, windows::core::PCWSTR(name.as_mut_ptr()))
        };
        match handle {
            // SAFETY: `GetLastError` is valid right after the call.
            Ok(handle) if unsafe { GetLastError() } == ERROR_ALREADY_EXISTS => {
                // SAFETY: the duplicate handle closes exactly once, here.
                unsafe {
                    let _ = windows::Win32::Foundation::CloseHandle(handle);
                }
                None
            }
            Ok(handle) => Some(InstanceGuard { handle }),
            Err(_) => None,
        }
    }

    /// Keeps the display and system awake while the player presents.
    /// Signage never sleeps on its own schedule.
    pub fn inhibit_sleep() {
        use windows::Win32::System::Power::{
            ES_CONTINUOUS, ES_DISPLAY_REQUIRED, ES_SYSTEM_REQUIRED, SetThreadExecutionState,
        };
        // SAFETY: execution-state flags only; no out-parameters.
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_DISPLAY_REQUIRED);
        }
    }

    /// Restores the default sleep behavior (process exit restores it
    /// anyway; this balances an early shutdown path).
    pub fn restore_sleep() {
        use windows::Win32::System::Power::{ES_CONTINUOUS, SetThreadExecutionState};
        // SAFETY: execution-state flags only; no out-parameters.
        unsafe {
            SetThreadExecutionState(ES_CONTINUOUS);
        }
    }

    /// Registers the player for restart after a crash, hang, update, or
    /// reboot. The restart runs the same command line the player
    /// started with; flags 0 restarts in every case.
    pub fn register_restart() -> bool {
        // SAFETY: a null command line reuses the process command line;
        // flags 0 restarts after crash, hang, update, and reboot.
        use windows::Win32::System::Recovery::{REGISTER_APPLICATION_RESTART_FLAGS, RegisterApplicationRestart};
        unsafe { RegisterApplicationRestart(None, REGISTER_APPLICATION_RESTART_FLAGS(0)).is_ok() }
    }

    /// Hides the cursor for kiosk presentation. Balanced by
    /// [`show_cursor`] at shutdown.
    pub fn hide_cursor() {
        // SAFETY: no parameters; the counter forces fully hidden.
        unsafe { while windows::Win32::UI::WindowsAndMessaging::ShowCursor(false) >= 0 {} }
    }

    /// Restores the cursor hidden by [`hide_cursor`].
    pub fn show_cursor() {
        // SAFETY: no parameters; the counter forces fully shown.
        unsafe { while windows::Win32::UI::WindowsAndMessaging::ShowCursor(true) < 0 {} }
    }

    /// Covers the window's current monitor borderlessly and reports the
    /// covered size in device pixels. The kiosk window never leaves
    /// fullscreen, so no placement is saved.
    pub fn enter_fullscreen(window: *mut std::ffi::c_void) -> Option<(u32, u32)> {
        use windows::Win32::Foundation::HWND;
        use windows::Win32::Graphics::Gdi::{MONITOR_DEFAULTTONEAREST, MONITORINFO, MonitorFromWindow};
        use windows::Win32::UI::WindowsAndMessaging::{
            GWL_STYLE, GetWindowLongW, HWND_TOP, SWP_FRAMECHANGED, SWP_NOOWNERZORDER, SWP_NOZORDER, SWP_SHOWWINDOW,
            SetWindowLongW, SetWindowPos, WINDOW_STYLE, WS_CAPTION, WS_MAXIMIZE, WS_MINIMIZE, WS_SYSMENU,
            WS_THICKFRAME,
        };
        let hwnd = HWND(window);
        // SAFETY: `window` is the UI thread's live main window.
        let style = WINDOW_STYLE(unsafe { GetWindowLongW(hwnd, GWL_STYLE) } as u32);
        // SAFETY: `window` is the UI thread's live main window; the new
        // style drops frame, caption, and system menu.
        unsafe {
            SetWindowLongW(
                hwnd,
                GWL_STYLE,
                (style & !(WS_CAPTION | WS_THICKFRAME | WS_MINIMIZE | WS_MAXIMIZE | WS_SYSMENU)).0 as i32,
            );
        }
        let mut info = MONITORINFO { cbSize: std::mem::size_of::<MONITORINFO>() as u32, ..Default::default() };
        // SAFETY: `info` carries its own size; the monitor handle comes
        // from the live window.
        let covered = unsafe {
            let monitor = MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST);
            windows::Win32::Graphics::Gdi::GetMonitorInfoW(monitor, &mut info).as_bool()
        };
        if !covered {
            return None;
        }
        let rect = info.rcMonitor;
        // SAFETY: `window` is the UI thread's live main window; the
        // rectangle is the monitor's own full area.
        unsafe {
            SetWindowPos(
                hwnd,
                Some(HWND_TOP),
                rect.left,
                rect.top,
                rect.right - rect.left,
                rect.bottom - rect.top,
                SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED | SWP_SHOWWINDOW,
            )
            .ok()?;
        }
        Some(((rect.right - rect.left).max(0) as u32, (rect.bottom - rect.top).max(0) as u32))
    }

    /// The primary monitor's pixel size, for pairing metadata and the
    /// heartbeat. The production window covers this monitor, so the
    /// metric is truthful without UI-thread coupling.
    pub fn primary_display_size() -> Option<(u32, u32)> {
        use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN};
        // SAFETY: pure metric reads.
        let (width, height) = unsafe { (GetSystemMetrics(SM_CXSCREEN), GetSystemMetrics(SM_CYSCREEN)) };
        (width > 0 && height > 0).then_some((width as u32, height as u32))
    }

    /// One captured window: tight BGRA rows, top to bottom.
    #[derive(Debug)]
    pub struct CapturedBgra {
        pub width: u32,
        pub height: u32,
        pub pixels: Vec<u8>,
    }

    /// Captures the final composed output of the player's own window with
    /// Windows Graphics Capture: the DWM frame, including the trusted
    /// Runtime view and every remote host layer. Capturing the process's
    /// own window needs no picker and shows no consent UI or border.
    ///
    /// Runs on a blocking thread (never the UI thread): it initializes its
    /// own multithreaded COM apartment, builds a throwaway D3D11 device
    /// and capture session, waits one frame, and reads the pixels back
    /// through a staging texture. Failures are static codes the capture
    /// broker maps to semantic capture errors.
    pub fn capture_window_bgra(
        window: *mut std::ffi::c_void,
        timeout: std::time::Duration,
    ) -> Result<CapturedBgra, &'static str> {
        use windows::Foundation::TypedEventHandler;
        use windows::Graphics::Capture::{Direct3D11CaptureFramePool, GraphicsCaptureItem};
        use windows::Graphics::DirectX::Direct3D11::IDirect3DDevice;
        use windows::Graphics::DirectX::DirectXPixelFormat;
        use windows::Win32::Foundation::{HMODULE, HWND};
        use windows::Win32::Graphics::Direct3D::{
            D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP, D3D_FEATURE_LEVEL_11_0,
        };
        use windows::Win32::Graphics::Direct3D11::{
            D3D11_CPU_ACCESS_READ, D3D11_CREATE_DEVICE_BGRA_SUPPORT, D3D11_MAP_READ, D3D11_MAPPED_SUBRESOURCE,
            D3D11_SDK_VERSION, D3D11_TEXTURE2D_DESC, D3D11_USAGE_STAGING, D3D11CreateDevice, ID3D11Device,
            ID3D11DeviceContext, ID3D11Multithread, ID3D11Resource, ID3D11Texture2D,
        };
        use windows::Win32::Graphics::Dxgi::Common::DXGI_FORMAT_B8G8R8A8_UNORM;
        use windows::Win32::Graphics::Dxgi::{IDXGIAdapter, IDXGIDevice};
        use windows::Win32::System::WinRT::Direct3D11::{
            CreateDirect3D11DeviceFromDXGIDevice, IDirect3DDxgiInterfaceAccess,
        };
        use windows::Win32::System::WinRT::Graphics::Capture::IGraphicsCaptureItemInterop;
        use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
        use windows::core::Interface as _;

        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                // SAFETY: balances the RoInitialize below on this thread.
                unsafe { RoUninitialize() };
            }
        }

        // SAFETY: the blocking thread has no COM apartment yet; the guard
        // balances it before the pooled thread is reused.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| "com_init")?;
        let _apartment = Apartment;

        let levels = [D3D_FEATURE_LEVEL_11_0];
        let mut device: Option<ID3D11Device> = None;
        let mut context: Option<ID3D11DeviceContext> = None;
        for driver in [D3D_DRIVER_TYPE_HARDWARE, D3D_DRIVER_TYPE_WARP] {
            // SAFETY: null adapter and module select the default device;
            // BGRA support is what the capture pool requires; the out-slots
            // are valid for the call.
            let status = unsafe {
                D3D11CreateDevice(
                    None::<&IDXGIAdapter>,
                    driver,
                    HMODULE(std::ptr::null_mut()),
                    D3D11_CREATE_DEVICE_BGRA_SUPPORT,
                    Some(&levels),
                    D3D11_SDK_VERSION,
                    Some(&mut device),
                    None,
                    Some(&mut context),
                )
            };
            if status.is_ok() && device.is_some() && context.is_some() {
                break;
            }
            device = None;
            context = None;
        }
        let (device, context) = device.zip(context).ok_or("no_d3d_device")?;
        let multithread: ID3D11Multithread = context.cast().map_err(|_| "no_d3d_device")?;
        // SAFETY: the immediate context outlives the call. The previous
        // protection state does not matter: this device only captures.
        unsafe {
            let _ = multithread.SetMultithreadProtected(true);
        }
        let dxgi: IDXGIDevice = device.cast().map_err(|_| "no_d3d_device")?;
        // SAFETY: the DXGI device is a live D3D11 device.
        let direct: IDirect3DDevice = unsafe { CreateDirect3D11DeviceFromDXGIDevice(&dxgi) }
            .map_err(|_| "no_d3d_device")?
            .cast()
            .map_err(|_| "no_d3d_device")?;

        // SAFETY: `window` is the UI thread's live main window; the capture
        // item only reads composed frames from it.
        let interop: IGraphicsCaptureItemInterop =
            windows::core::factory::<GraphicsCaptureItem, IGraphicsCaptureItemInterop>().map_err(|_| "capture_item")?;
        let item: GraphicsCaptureItem = unsafe { interop.CreateForWindow(HWND(window)) }.map_err(|_| "capture_item")?;
        let size = item.Size().map_err(|_| "capture_item")?;
        if size.Width <= 0 || size.Height <= 0 {
            return Err("capture_item");
        }
        let pool = Direct3D11CaptureFramePool::CreateFreeThreaded(
            &direct,
            DirectXPixelFormat::B8G8R8A8UIntNormalized,
            2,
            size,
        )
        .map_err(|_| "capture_item")?;
        let session = pool.CreateCaptureSession(&item).map_err(|_| "capture_item")?;
        // The cursor is hidden while signage runs; leaving it out of
        // frames is best-effort, never a capture failure.
        let _ = session.SetIsCursorCaptureEnabled(false);
        let (arrived_tx, arrived_rx) = std::sync::mpsc::channel::<()>();
        let arrived = TypedEventHandler::new(move |_pool, _args| {
            let _ = arrived_tx.send(());
            Ok(())
        });
        let _token = pool.FrameArrived(&arrived).map_err(|_| "capture_item")?;
        session.StartCapture().map_err(|_| "capture_item")?;
        arrived_rx.recv_timeout(timeout).map_err(|_| "no_frame")?;
        let frame = pool.TryGetNextFrame().map_err(|_| "no_frame")?;
        let content = frame.ContentSize().map_err(|_| "no_frame")?;
        let surface = frame.Surface().map_err(|_| "no_frame")?;
        let access: IDirect3DDxgiInterfaceAccess = surface.cast().map_err(|_| "readback")?;
        // SAFETY: the surface comes from a D3D11 frame pool.
        let texture: ID3D11Texture2D = unsafe { access.GetInterface() }.map_err(|_| "readback")?;
        let mut desc: D3D11_TEXTURE2D_DESC = unsafe { std::mem::zeroed() };
        // SAFETY: the description out-slot is valid for the call.
        unsafe {
            texture.GetDesc(&mut desc);
        }
        if desc.Format != DXGI_FORMAT_B8G8R8A8_UNORM || desc.SampleDesc.Count != 1 {
            return Err("readback");
        }
        let (width, height) = (content.Width.clamp(0, size.Width) as u32, content.Height.clamp(0, size.Height) as u32);
        // A resize racing the capture shrinks the valid region to the
        // texture the pool actually produced.
        let (width, height) = (width.min(desc.Width), height.min(desc.Height));
        if width == 0 || height == 0 || width > 8192 || height > 8192 {
            return Err("readback");
        }
        desc.Usage = D3D11_USAGE_STAGING;
        desc.BindFlags = 0;
        desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ.0 as u32;
        desc.MiscFlags = 0;
        let mut staging: Option<ID3D11Texture2D> = None;
        // SAFETY: the description is the validated pool format; the
        // out-slot is valid for the call.
        unsafe { device.CreateTexture2D(&desc, None, Some(&mut staging)) }.map_err(|_| "readback")?;
        let staging = staging.ok_or("readback")?;
        let source: ID3D11Resource = texture.cast().map_err(|_| "readback")?;
        let target: ID3D11Resource = staging.cast().map_err(|_| "readback")?;
        // SAFETY: both resources are live textures of one description.
        unsafe {
            context.CopyResource(&target, &source);
        }
        let mut mapped: D3D11_MAPPED_SUBRESOURCE = unsafe { std::mem::zeroed() };
        // SAFETY: the staging texture is CPU-readable; the map out-slot is
        // valid for the call.
        unsafe { context.Map(&target, 0, D3D11_MAP_READ, 0, Some(&mut mapped)) }.map_err(|_| "readback")?;
        let row_pitch = mapped.RowPitch as usize;
        let row_len = width as usize * 4;
        if mapped.pData.is_null() || row_pitch < row_len {
            // SAFETY: balances the Map above.
            unsafe {
                context.Unmap(&target, 0);
            }
            return Err("readback");
        }
        let mut pixels = vec![0u8; row_len * height as usize];
        // SAFETY: the mapped region holds `height` rows of at least
        // `row_pitch` bytes; each copied row is the validated `row_len`.
        unsafe {
            for (row, chunk) in pixels.chunks_exact_mut(row_len).enumerate() {
                let from = mapped.pData.add(row * row_pitch) as *const u8;
                chunk.copy_from_slice(std::slice::from_raw_parts(from, row_len));
            }
            context.Unmap(&target, 0);
        }
        let _ = session.Close();
        let _ = pool.Close();
        Ok(CapturedBgra { width, height, pixels })
    }

    /// The current package full name when this process runs from its
    /// MSIX package; `None` for unpackaged developer builds. Updates
    /// deploy only onto a packaged installation.
    pub fn current_package_full_name() -> Option<String> {
        use windows::Win32::Foundation::APPMODEL_ERROR_NO_PACKAGE;
        use windows::Win32::Storage::Packaging::Appx::GetCurrentPackageFullName;
        use windows::core::PWSTR;
        let mut length = 0u32;
        // SAFETY: a length-only probe; no buffer changes hands.
        if unsafe { GetCurrentPackageFullName(&mut length, None) } == APPMODEL_ERROR_NO_PACKAGE {
            return None;
        }
        if length == 0 {
            return None;
        }
        let mut name = vec![0u16; length as usize];
        // SAFETY: the buffer holds `length` UTF-16 units for the call.
        if unsafe { GetCurrentPackageFullName(&mut length, Some(PWSTR(name.as_mut_ptr()))) }.0 != 0 {
            return None;
        }
        let end = name.iter().position(|unit| *unit == 0).unwrap_or(name.len());
        String::from_utf16(&name[..end]).ok().filter(|text| !text.is_empty())
    }

    /// Deploys a verified MSIX package over this installation with the
    /// platform package manager: Windows verifies the package signature
    /// and publisher trust, which the envelope never replaces. No force
    /// flags: the running process keeps its old files until it exits,
    /// and the new version activates on the relaunch that follows.
    ///
    /// Runs on its own MTA thread with a hermetic runtime for the
    /// deployment operation; never the UI thread or a Tokio worker.
    pub fn deploy_msix(msix: &std::path::Path) -> Result<(), String> {
        let uri = crate::msix::package_uri(msix)
            .ok_or_else(|| "the package path is not an absolute local file".to_string())?;
        std::thread::Builder::new()
            .name("tilecast-msix-deploy".to_string())
            .spawn(move || deploy_blocking(&uri))
            .map_err(|error| format!("the deployment thread did not start: {error}"))?
            .join()
            .map_err(|_| "the deployment thread failed".to_string())?
    }

    fn deploy_blocking(uri: &str) -> Result<(), String> {
        use windows::Foundation::Uri;
        use windows::Management::Deployment::{DeploymentOptions, DeploymentResult, PackageManager};
        use windows::Win32::System::WinRT::{RO_INIT_MULTITHREADED, RoInitialize, RoUninitialize};
        use windows::core::HSTRING;
        use windows_collections::IIterable;

        struct Apartment;
        impl Drop for Apartment {
            fn drop(&mut self) {
                // SAFETY: balances the RoInitialize below on this thread.
                unsafe { RoUninitialize() };
            }
        }

        // SAFETY: this thread has no COM apartment yet; the guard
        // balances it before the thread ends.
        unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|error| format!("COM did not initialize: {error}"))?;
        let _apartment = Apartment;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("the deployment runtime did not start: {error}"))?;
        runtime.block_on(async {
            let manager =
                PackageManager::new().map_err(|error| format!("the package manager is unavailable: {error}"))?;
            let package =
                Uri::CreateUri(&HSTRING::from(uri)).map_err(|error| format!("the package URI is invalid: {error}"))?;
            let operation = manager
                .AddPackageAsync(&package, None::<&IIterable<Uri>>, DeploymentOptions::None)
                .map_err(|error| format!("deployment did not start: {error}"))?;
            let result: DeploymentResult = tokio::time::timeout(std::time::Duration::from_secs(600), operation)
                .await
                .map_err(|_| "deployment timed out".to_string())?
                .map_err(|error| format!("deployment failed: {error}"))?;
            let code =
                result.ExtendedErrorCode().map_err(|error| format!("deployment status is unavailable: {error}"))?;
            if code.is_ok() {
                Ok(())
            } else {
                let text = result.ErrorText().map(|text| text.to_string()).unwrap_or_default();
                let text: String = text.chars().take(200).collect();
                Err(format!("deployment failed ({code:?}): {text}"))
            }
        })
    }
}

#[cfg(not(windows))]
mod imp {
    use std::path::{Path, PathBuf};

    pub fn local_app_data() -> Option<PathBuf> {
        None
    }

    pub fn protect_user_data(_plaintext: &[u8]) -> std::io::Result<Vec<u8>> {
        Err(std::io::Error::other("DPAPI is only available on Windows"))
    }

    pub fn unprotect_user_data(_sealed: &[u8]) -> std::io::Result<Vec<u8>> {
        Err(std::io::Error::other("DPAPI is only available on Windows"))
    }

    pub fn available_bytes(_path: &Path) -> std::io::Result<u64> {
        Err(std::io::Error::other("disk free space is only available on Windows"))
    }

    pub fn tick_count_ms() -> Option<u64> {
        None
    }

    pub fn machine_registry_string(_subkey: &str, _value: &str) -> Option<String> {
        None
    }

    pub fn user_locale_name() -> Option<String> {
        None
    }

    pub fn os_build_number() -> Option<String> {
        None
    }

    pub fn os_product_name() -> Option<String> {
        None
    }

    pub fn register_remote_class() -> bool {
        false
    }

    pub fn create_remote_child(
        _parent: *mut std::ffi::c_void,
        _x: i32,
        _y: i32,
        _width: i32,
        _height: i32,
        _visible: bool,
    ) -> Option<*mut std::ffi::c_void> {
        None
    }

    pub fn move_remote_child(_child: *mut std::ffi::c_void, _x: i32, _y: i32, _width: i32, _height: i32) {}

    pub fn show_remote_child(_child: *mut std::ffi::c_void, _visible: bool) {}

    pub fn destroy_remote_child(_child: *mut std::ffi::c_void) {}

    pub fn start_poll_timer(_window: *mut std::ffi::c_void, _id: usize, _interval_ms: u32) -> bool {
        false
    }

    pub fn stop_poll_timer(_window: *mut std::ffi::c_void, _id: usize) {}

    pub const SINGLE_INSTANCE_MUTEX: &str = r"Local\TilecastPlayerSingleInstance";

    #[derive(Debug)]
    pub struct InstanceGuard {
        _private: (),
    }

    pub fn claim_single_instance() -> Option<InstanceGuard> {
        Some(InstanceGuard { _private: () })
    }

    pub fn inhibit_sleep() {}

    pub fn restore_sleep() {}

    pub fn register_restart() -> bool {
        false
    }

    pub fn hide_cursor() {}

    pub fn show_cursor() {}

    pub fn enter_fullscreen(_window: *mut std::ffi::c_void) -> Option<(u32, u32)> {
        None
    }

    pub fn primary_display_size() -> Option<(u32, u32)> {
        None
    }

    /// One captured window: tight BGRA rows, top to bottom.
    #[derive(Debug)]
    pub struct CapturedBgra {
        pub width: u32,
        pub height: u32,
        pub pixels: Vec<u8>,
    }

    pub fn capture_window_bgra(
        _window: *mut std::ffi::c_void,
        _timeout: std::time::Duration,
    ) -> Result<CapturedBgra, &'static str> {
        Err("unsupported")
    }

    pub fn current_package_full_name() -> Option<String> {
        None
    }

    pub fn deploy_msix(_msix: &std::path::Path) -> Result<(), String> {
        Err("MSIX deployment is only available on Windows".to_string())
    }
}

pub use imp::*;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn single_instance_claims_exactly_once_per_session() {
        {
            let first = claim_single_instance();
            assert!(first.is_some());
            // Off Windows the stub always claims; on Windows the session
            // mutex refuses the second claim while the first is held.
            #[cfg(windows)]
            assert!(claim_single_instance().is_none());
        }
        #[cfg(windows)]
        assert!(claim_single_instance().is_some());
    }
}
