package org.tilecast.player.content

import org.tilecast.player.network.ManifestAsset
import org.tilecast.player.network.ManifestItem
import org.tilecast.player.network.ManifestPlaylist
import java.time.Duration
import java.time.Instant

data class PlaybackCursor(val index: Int, val cycle: Int)
internal data class SynchronizedPlaybackStart(val cursor: PlaybackCursor, val offsetMs: Long)

internal fun synchronizedPlaybackStart(
    playlist: ManifestPlaylist,
    assets: List<ManifestAsset>,
    anchor: Instant,
    now: Instant,
): SynchronizedPlaybackStart {
    if (playlist.items.isEmpty() || !now.isAfter(anchor)) {
        return SynchronizedPlaybackStart(PlaybackCursor(0, 0), 0)
    }
    val durations = playlist.items.map { item -> effectiveDurationMs(item, assets) }
    val cycleDuration = durations.sum().coerceAtLeast(1)
    var elapsed = Duration.between(anchor, now).toMillis().coerceAtLeast(0) % cycleDuration
    var index = 0
    while (index < durations.lastIndex && elapsed >= durations[index]) {
        elapsed -= durations[index]
        index++
    }
    return SynchronizedPlaybackStart(PlaybackCursor(index, 0), elapsed)
}

internal fun effectiveDurationMs(item: ManifestItem, assets: List<ManifestAsset>): Long {
    item.durationMs?.let { return it.coerceAtLeast(1) }
    if (item.assetType == "website" || item.assetType == "widget") return 30_000
    val asset = item.variantId?.let { variant -> assets.firstOrNull { it.variantId == variant } }
    if (asset?.mimeType?.startsWith("video/") == true) {
        val start = item.videoStartOffsetMs ?: 0
        val end = item.videoEndOffsetMs ?: asset.durationSeconds?.times(1000)?.toLong()
        if (end != null) return (end - start).coerceAtLeast(1)
    }
    return 10_000
}
