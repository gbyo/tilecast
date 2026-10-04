# Animated logos

Looping versions of the Tilecast logo for loading and startup screens. Only the
tile mark moves. The wordmark stays still.

| Animation | What it does                                                 | Loop |
| --------- | ------------------------------------------------------------ | ---- |
| `cast`    | The front tile taps and the two back tiles ripple out of it. | 2.4s |
| `stack`   | The tiles drop in back to front, hold, then slide out.       | 2.6s |
| `pulse`   | A brightness wave runs through the three tiles.              | 1.5s |

Each animation comes in four files:

- `tilecast-logo-<animation>-black.svg` is the full logo for light surfaces.
- `tilecast-logo-<animation>-white.svg` is the full logo for dark surfaces.
- `tilecast-mark-<animation>-black.svg` is the mark only, for light surfaces.
- `tilecast-mark-<animation>-white.svg` is the mark only, for dark surfaces.

The files are self-contained. The animation is CSS inside the SVG, so a plain
`<img src="tilecast-mark-cast-white.svg">` loops with no script. When the
viewer has reduced motion turned on, the files show the static logo.

The canvas is padded 25 units on every side because the tiles move past their
resting position. Do not crop the padding or the tiles clip mid-animation. The
padding also means these files do not line up exactly with the static logos in
`.github/logos/`.

These files use the same paths as the static logos. If the logo changes,
update these too.

The bouncing logo that shows outside active hours uses `cast`. The Player
Runtime bundles a copy at `packages/player-runtime/static/`, and the Android
player redraws it in `TilecastCastLogo.kt`. Update both with the source file.
