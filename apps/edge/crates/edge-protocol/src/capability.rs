//! Compatibility path for shared native Player values.
pub use player_types::capability::*;

/// Edge provider identifiers. Shared policy does not select a renderer or OS.
pub mod ids {
    pub use player_types::capability::ids::*;
    pub const RENDERER_WPE: &str = "renderer.wpe";
    pub const RENDERER_WPE_DRM: &str = "renderer.wpe.drm";
    pub const RENDERER_WPE_WAYLAND: &str = "renderer.wpe.wayland";
    pub const RENDERER_WPE_HEADLESS: &str = "renderer.wpe.headless";
    pub const DISPLAY_CEC_POWER: &str = "display.cec.power";
    pub const DISPLAY_CEC_INPUT: &str = "display.cec.input";
    pub const DISPLAY_DDC_BRIGHTNESS: &str = "display.ddc.brightness";
    pub const DISPLAY_DDC_VOLUME: &str = "display.ddc.volume";
    pub const DISPLAY_DDC_MUTE: &str = "display.ddc.mute";
    pub const AUDIO_PIPEWIRE: &str = "audio.pipewire";
    pub const SYSTEM_SYSTEMD_WATCHDOG: &str = "system.systemd_watchdog";
}
