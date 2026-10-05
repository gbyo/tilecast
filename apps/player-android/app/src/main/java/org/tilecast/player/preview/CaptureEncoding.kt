package org.tilecast.player.preview

import android.graphics.Bitmap
import java.io.ByteArrayOutputStream
import kotlin.math.min
import kotlin.math.roundToInt

internal data class EncodedPreview(val bytes: ByteArray, val width: Int, val height: Int)

internal data class PreviewDimensions(val width: Int, val height: Int)

/** Scales a capture target inside the requested bounds without ever upscaling. */
internal fun scaledDimensions(
    width: Int,
    height: Int,
    maxWidth: Int,
    maxHeight: Int,
): PreviewDimensions {
    require(width > 0 && height > 0 && maxWidth > 0 && maxHeight > 0)
    val scale = min(1.0, min(maxWidth.toDouble() / width, maxHeight.toDouble() / height))
    return PreviewDimensions(
        width = (width * scale).roundToInt().coerceAtLeast(1),
        height = (height * scale).roundToInt().coerceAtLeast(1),
    )
}

/**
 * JPEG-encodes a captured frame inside [maxBytes], stepping quality down
 * and then shrinking the bitmap until it fits. Returns null when even the
 * smallest attempt exceeds the budget, so the caller reports an honest
 * encode failure instead of an oversized frame.
 */
internal fun encodeCaptureFrame(source: Bitmap, maxBytes: Int): EncodedPreview? {
    var current = source
    var ownsCurrent = false
    try {
        repeat(4) {
            for (quality in intArrayOf(50, 42, 34, 28)) {
                val output = ByteArrayOutputStream()
                if (current.compress(Bitmap.CompressFormat.JPEG, quality, output)) {
                    val bytes = output.toByteArray()
                    if (bytes.size <= maxBytes) {
                        return EncodedPreview(bytes, current.width, current.height)
                    }
                }
            }
            if (current.width <= 240 || current.height <= 135) return null
            val next = Bitmap.createScaledBitmap(
                current,
                (current.width * 0.8).roundToInt().coerceAtLeast(1),
                (current.height * 0.8).roundToInt().coerceAtLeast(1),
                true,
            )
            if (ownsCurrent) current.recycle()
            current = next
            ownsCurrent = true
        }
        return null
    } finally {
        if (ownsCurrent) current.recycle()
    }
}
