import SwiftUI

/// Native rendering of `.github/logos/animated/tilecast-mark-cast-black.svg`.
/// Keep the paths, padded canvas, and timing aligned with that source asset.
struct TilecastLoadingMark: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.scenePhase) private var scenePhase

    // All loading surfaces share one epoch so SwiftUI can replace one mark
    // with another (for example verification -> Studio loading) without
    // visibly restarting the cast animation.
    private static let startedAt = Date()

    var body: some View {
        TimelineView(.animation(minimumInterval: 1 / 30, paused: reduceMotion || scenePhase != .active)) { timeline in
            Canvas { context, size in
                let scale = min(size.width / 307.49, size.height / 295.25)
                context.translateBy(x: (size.width - 307.49 * scale) / 2, y: (size.height - 295.25 * scale) / 2)
                context.scaleBy(x: scale, y: scale)
                context.translateBy(x: 25, y: 25)
                let elapsed = max(0, timeline.date.timeIntervalSince(Self.startedAt))
                for (index, path) in Self.tiles.enumerated() {
                    var tile = context
                    if !reduceMotion {
                        if index < 2 {
                            let delay = index == 0 ? 0.22 : 0
                            // CSS animation-delay leaves the back tile hidden on the first cycle.
                            let phase = max(0, elapsed - delay).truncatingRemainder(dividingBy: 2.4) / 2.4
                            let initial = index == 0 ? CGSize(width: 75.4, height: 66.1) : CGSize(width: 37.7, height: 33.1)
                            let state = Self.wave(at: phase, initial: initial)
                            tile.opacity = elapsed < delay ? 0 : state.opacity
                            tile.translateBy(x: state.offset.width, y: state.offset.height)
                        } else {
                            let phase = elapsed.truncatingRemainder(dividingBy: 2.4) / 2.4
                            let pulse = Self.frontScale(at: phase)
                            let center = CGPoint(x: path.boundingRect.midX, y: path.boundingRect.midY)
                            tile.translateBy(x: center.x, y: center.y)
                            tile.scaleBy(x: pulse, y: pulse)
                            tile.translateBy(x: -center.x, y: -center.y)
                        }
                    }
                    tile.fill(path, with: .foreground)
                }
            }
        }
        .frame(width: 80, height: 80 * 295.25 / 307.49)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text("Loading…"))
    }

    private static let waveCurve = UnitCurve.bezier(
        startControlPoint: UnitPoint(x: 0.22, y: 1), endControlPoint: UnitPoint(x: 0.36, y: 1)
    )

    private static func wave(at phase: Double, initial: CGSize) -> (opacity: Double, offset: CGSize) {
        let opacity = interpolate(phase, stops: [(0, 0), (0.12, 1), (0.55, 1), (0.8, 0), (1, 0)], curve: waveCurve)
        let x = interpolate(phase, stops: [(0, initial.width), (0.55, 0), (0.8, -13.2), (1, -13.2)], curve: waveCurve)
        let y = interpolate(phase, stops: [(0, initial.height), (0.55, 0), (0.8, -11.6), (1, -11.6)], curve: waveCurve)
        return (opacity, CGSize(width: x, height: y))
    }

    private static func frontScale(at phase: Double) -> Double {
        interpolate(phase, stops: [(0, 1), (0.08, 0.94), (0.2, 1.02), (0.32, 1), (1, 1)], curve: .easeInOut)
    }

    private static func interpolate(_ phase: Double, stops: [(Double, Double)], curve: UnitCurve) -> Double {
        for (start, end) in zip(stops, stops.dropFirst()) where phase <= end.0 {
            let progress = curve.value(at: (phase - start.0) / (end.0 - start.0))
            return start.1 + (end.1 - start.1) * progress
        }
        return stops.last?.1 ?? 0
    }

    private static let tiles: [Path] = [
        Path { path in
            path.move(to: CGPoint(x: 0, y: 63.79))
            path.addCurve(to: CGPoint(x: 14.21, y: 46.93), control1: CGPoint(x: 0, y: 54.86), control2: CGPoint(x: 4.96, y: 49.58))
            path.addLine(to: CGPoint(x: 157.01, y: 3.63))
            path.addCurve(to: CGPoint(x: 176.51, y: 16.19), control1: CGPoint(x: 168.57, y: 0), control2: CGPoint(x: 176.51, y: 3.96))
            path.addLine(to: CGPoint(x: 176.51, y: 33.05))
            path.addLine(to: CGPoint(x: 43.96, y: 69.74))
            path.addCurve(to: CGPoint(x: 26.44, y: 90.89), control1: CGPoint(x: 32.39, y: 73.04), control2: CGPoint(x: 26.44, y: 79.32))
            path.addLine(to: CGPoint(x: 26.44, y: 172.2))
            path.addCurve(to: CGPoint(x: 20.49, y: 180.14), control1: CGPoint(x: 26.44, y: 176.17), control2: CGPoint(x: 24.46, y: 178.82))
            path.addLine(to: CGPoint(x: 15.87, y: 181.46))
            path.addCurve(to: CGPoint(x: 0, y: 169.89), control1: CGPoint(x: 6.28, y: 184.1), control2: CGPoint(x: 0, y: 179.48))
            path.addLine(to: CGPoint(x: 0, y: 63.79))
            path.closeSubpath()
        },
        Path { path in
            path.move(to: CGPoint(x: 38.01, y: 96.18))
            path.addCurve(to: CGPoint(x: 52.56, y: 78.99), control1: CGPoint(x: 38.01, y: 86.93), control2: CGPoint(x: 43.3, y: 81.64))
            path.addLine(to: CGPoint(x: 199.31, y: 38.01))
            path.addCurve(to: CGPoint(x: 219.48, y: 50.57), control1: CGPoint(x: 211.54, y: 34.37), control2: CGPoint(x: 219.48, y: 38.67))
            path.addLine(to: CGPoint(x: 219.48, y: 66.1))
            path.addLine(to: CGPoint(x: 82.3, y: 102.46))
            path.addCurve(to: CGPoint(x: 64.46, y: 124.94), control1: CGPoint(x: 70.41, y: 105.77), control2: CGPoint(x: 64.46, y: 112.38))
            path.addLine(to: CGPoint(x: 64.46, y: 201.29))
            path.addCurve(to: CGPoint(x: 58.18, y: 209.89), control1: CGPoint(x: 64.46, y: 205.92), control2: CGPoint(x: 62.47, y: 208.56))
            path.addLine(to: CGPoint(x: 53.55, y: 211.87))
            path.addCurve(to: CGPoint(x: 38.01, y: 200.3), control1: CGPoint(x: 44.29, y: 214.51), control2: CGPoint(x: 38.01, y: 209.89))
            path.addLine(to: CGPoint(x: 38.01, y: 96.18))
            path.closeSubpath()
        },
        Path { path in
            path.move(to: CGPoint(x: 75.36, y: 130.23))
            path.addCurve(to: CGPoint(x: 89.25, y: 113.7), control1: CGPoint(x: 75.36, y: 121.96), control2: CGPoint(x: 80.32, y: 116.34))
            path.addLine(to: CGPoint(x: 237, y: 72.05))
            path.addCurve(to: CGPoint(x: 257.49, y: 85.27), control1: CGPoint(x: 249.22, y: 68.42), control2: CGPoint(x: 257.49, y: 73.04))
            path.addLine(to: CGPoint(x: 257.49, y: 184.76))
            path.addCurve(to: CGPoint(x: 243.28, y: 201.29), control1: CGPoint(x: 257.49, y: 193.36), control2: CGPoint(x: 252.53, y: 198.65))
            path.addLine(to: CGPoint(x: 96.19, y: 241.62))
            path.addCurve(to: CGPoint(x: 75.36, y: 228.4), control1: CGPoint(x: 83.3, y: 245.25), control2: CGPoint(x: 75.36, y: 240.63))
            path.addLine(to: CGPoint(x: 75.36, y: 130.23))
            path.closeSubpath()
        },
    ]
}
