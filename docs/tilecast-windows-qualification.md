# Tilecast Windows qualification

This ledger proves the Windows host-layer rendering model on real
Windows hardware. It records stage 6 rendering qualification, the 1.0
physical release gates, and the WebView2 distribution policy. The
Windows platform services under test live in
`tilecast-windows.md`.

## Method

Qualify Windows x64 and Windows ARM64 independently. A pass on one
architecture never covers the other. Emulation is not ARM64 support.

No item passes through CI or through this document alone. Each item
passes only with dated evidence from the named hardware: logs,
screenshots, or capture output stored with the release record.

Player Core and Player Runtime do not change for Windows renderer
findings. Windows findings change the Windows host only.

## Stage 6 rendering qualification

The Windows host shows remote pages and YouTube players in ordinary
child WebView2 views of one kiosk window:

```text
Tilecast top-level kiosk HWND
├── trusted Runtime WebView2
├── remote Website child WebView2
├── remote Website/YouTube child WebView2
└── ...
```

The host owns child positioning and z-order. The host applies the
Runtime-provided viewport. Status `pending` means no physical run yet.

| #   | Item                    | Procedure                                               | Evidence                                                | x64     | ARM64   |
| --- | ----------------------- | ------------------------------------------------------- | ------------------------------------------------------- | ------- | ------- |
| 1   | Multiple controllers    | Show a Layout with four remote zones.                   | All four views show content. No error event.            | pending | pending |
| 2   | Repeated create/destroy | Rotate a playlist with Website items for one hour.      | No handle or memory growth. No orphan window.           | pending | pending |
| 3   | Warm surfaces           | Revisit a kept-warm Website item.                       | The item shows without a new load event.                | pending | pending |
| 4   | Move/resize             | Change Layout placements while a Website shows.         | The view follows within one frame budget. No tearing.   | pending | pending |
| 5   | DPI scaling             | Run at 100%, 150% and 200% scaling.                     | Text stays sharp. Viewports match the Layout.           | pending | pending |
| 6   | Fullscreen              | Enter and leave borderless fullscreen.                  | Remote views cover and uncover with the window.         | pending | pending |
| 7   | Z-order                 | Overlap a remote zone with ticker and alert plugins.    | The remote view stays above the Runtime.                | pending | pending |
| 8   | Layout zones            | Show image, video and Website zones together.           | Each zone shows its own content.                        | pending | pending |
| 9   | Hide/show               | Hide and show a Website item.                           | The view hides and returns. YouTube pauses and resumes. | pending | pending |
| 10  | Root Website playback   | Play a fullscreen Website playlist item.                | The page loads and shows for its duration.              | pending | pending |
| 11  | Remote-web audio        | Unmute a Website and a YouTube item.                    | Audio plays. Mute stops all view audio.                 | pending | pending |
| 12  | Host-layer transitions  | Transition into and out of a Website item.              | No black flash longer than one frame budget.            | pending | pending |
| 13  | Browser-process crash   | Kill the remote browser process.                        | `process-terminated` fires. Recovery re-creates views.  | pending | pending |
| 14  | Renderer-process crash  | Kill a remote renderer process.                         | Surfaces fail with codes. The Runtime recovers.         | pending | pending |
| 15  | Final-output capture    | Capture Preview and Watch Live during Website playback. | The capture shows Runtime plus remote views.            | pending | pending |

## Rendering architecture decisions

DirectComposition stays out. The host uses ordinary child WebViews
until physical evidence shows they cannot meet the rendering or
capture contract. Item 15 is the capture evidence. If child views do
not appear correctly in the captured result, that evidence moves the
renderer adapter to `CompositionController` plus DirectComposition.
No other finding triggers that move.

The application ships no DPI manifest. The window layer sets
per-monitor version 2 awareness before it creates any window. That
call is sufficient and it is already in place. Monitor moves and
scale changes belong to the stage 7 fullscreen behavior.

## 1.0 physical release gates

Each gate needs a dated pass on Windows x64 and on Windows ARM64.

- Fresh MSIX install.
- WebView2 missing, with the provisioning path.
- Pairing.
- Server identity mismatch.
- Reboot and autostart.
- Fullscreen.
- Offline cold boot.
- Image playback.
- Long video with seeking.
- Widgets V2.
- Layouts.
- Multiple Layout zones.
- Websites.
- YouTube.
- Synchronized playback.
- Takeover.
- Server loss and recovery.
- Browser-process crash.
- Renderer recovery and safe mode.
- Low disk.
- Preview.
- Watch Live.
- Sleep and wake.
- Signed update.
- Interrupted update.
- Relaunch.
- Wrong-family and wrong-architecture update rejection.
- Long-running mixed-content soak.

## WebView2 distribution policy

The Player uses the Evergreen WebView2 Runtime. The Player detects
the installed engine version at startup and records it in host
diagnostics. Machines without the runtime use the provisioning path
with the Microsoft Evergreen redistributable or standalone
installer, including offline-prepared installations.

The Player does not bundle Fixed Version WebView2. A fixed-runtime
option may arrive only for a demonstrated air-gapped or compliance
requirement.

Qualification exercises the current Evergreen version. Where
practical, it also exercises the upcoming version before release.
