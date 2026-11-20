//! The process shape for a presenting Player: AppKit owns the main thread
//! and its run loop, where the WKWebView renderer lives
//! ([`crate::webkit`]); the Player daemon runs on a Tokio runtime on other
//! threads and reaches the renderer only through the bounded UI channels.
//!
//! This is the minimal application the renderer needs. Kiosk behavior
//! (full screen, Dock and menu bar, sleep, login startup, relaunch) belongs
//! to gbyo/tilecast#1930.

/// Runs `player` to completion on a worker thread while the main thread
/// runs AppKit, then exits the process with `player`'s status. Never
/// returns on macOS. Off macOS, or without a main thread, it runs `player`
/// on the calling thread.
pub fn run_presenting<F>(player: F) -> i32
where
    F: FnOnce() -> i32 + Send + 'static,
{
    #[cfg(target_os = "macos")]
    if let Some(mtm) = objc2::MainThreadMarker::new() {
        use objc2_app_kit::{NSApplication, NSApplicationActivationPolicy};
        let app = NSApplication::sharedApplication(mtm);
        app.setActivationPolicy(NSApplicationActivationPolicy::Regular);
        let spawned = std::thread::Builder::new().name("tilecast-player".to_owned()).spawn(move || {
            let status = player();
            // The daemon has shut down cleanly (or failed); AppKit has no
            // state worth unwinding.
            std::process::exit(status);
        });
        if let Err(error) = spawned {
            eprintln!("Tilecast Player could not start: {error}");
            return 1;
        }
        #[allow(deprecated)]
        app.activateIgnoringOtherApps(true);
        app.run();
        return 0;
    }
    player()
}
