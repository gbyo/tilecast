# @tilecast/player-runtime

The shared Tilecast Player Runtime: the trusted display document that the Electron player and the WPE renderer both host from `tilecast://runtime/index.html`.

The design, the host contract (`TilecastRuntimeHostV1`), the Lit and XState architecture, the conformance suite and the measured performance are in [`docs/player-runtime.md`](../../docs/player-runtime.md).

| Directory         | Contents                                                                                              |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `src/host`        | The host contract. Hosts that run in Node import it through `@tilecast/player-runtime/host-contract`. |
| `src/engine`      | XState playback machines, the synchronized timeline and the playback policy. No DOM.                  |
| `src/clock`       | The scheduler (the only user of browser timers) and the shared-timeline math.                         |
| `src/surfaces`    | `MediaSurface` implementations and the stage.                                                         |
| `src/transitions` | Web Animations transitions.                                                                           |
| `src/views`       | Lit views in light DOM.                                                                               |
| `src/compat`      | Compatibility code: RenderNode projection and interpretation, and the built-in plugin surfaces.       |
| `src/widgets`     | The contract for future first-class widget components.                                                |
| `static`          | `index.html`, `runtime.css`, the logo and the font licence.                                           |
| `conformance`     | The cross-engine conformance fixtures, runners, comparison and performance scenarios.                 |

```sh
npm run typecheck --workspace @tilecast/player-runtime
npm test --workspace @tilecast/player-runtime
npm run build --workspace @tilecast/player-runtime
```
