package org.tilecast.player.runtime

import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.io.FilterInputStream
import java.io.InputStream

/** Serves host-authorized cached media to the trusted runtime WebView.
 *
 * Intercepts `tcmedia:` URLs (see [MediaAuthorization]) and serves the
 * verified cache file with correct Range/206 semantics for HTML media.
 * The pure [resolve] is unit-tested; [toResponse] is a thin framework adapter.
 */
object TcMediaBridge {
    data class ResolvedMedia(
        val statusCode: Int,
        val reason: String,
        val mimeType: String,
        val contentLength: Long,
        val contentRange: String?,
        val file: File?,
        val offset: Long,
    )

    fun resolve(
        rawUri: String?,
        authorized: Set<MediaAuthorization.AuthorizedMedia>,
        localFiles: Map<String, String>,
        mimeByVariant: Map<String, String>,
        rangeHeader: String?,
    ): ResolvedMedia? {
        val media = MediaAuthorization.authorize(rawUri, authorized) ?: return null
        val path = localFiles[media.variantId] ?: return null
        val file = File(path)
        if (!file.isFile) return null
        val length = file.length()
        val mime = mimeByVariant[media.variantId] ?: "application/octet-stream"
        return when (val decision = MediaAuthorization.decideRange(rangeHeader, length)) {
            is MediaAuthorization.RangeDecision.Full ->
                ResolvedMedia(200, "OK", mime, length, null, file, 0)
            is MediaAuthorization.RangeDecision.Partial -> {
                val range = decision.range
                ResolvedMedia(
                    statusCode = 206,
                    reason = "Partial Content",
                    mimeType = mime,
                    contentLength = range.endInclusive - range.start + 1,
                    contentRange = MediaAuthorization.contentRangeHeader(range, length),
                    file = file,
                    offset = range.start,
                )
            }
            is MediaAuthorization.RangeDecision.Unsatisfiable ->
                ResolvedMedia(416, "Range Not Satisfiable", mime, 0, "bytes */$length", null, 0)
            is MediaAuthorization.RangeDecision.Invalid -> null
        }
    }

    fun responseHeaders(resolved: ResolvedMedia): Map<String, String> {
        val headers = mutableMapOf(
            "Accept-Ranges" to "bytes",
            "Content-Length" to resolved.contentLength.toString(),
            "Content-Type" to resolved.mimeType,
        )
        resolved.contentRange?.let { headers["Content-Range"] = it }
        return headers
    }

    /** Opens exactly the response body declared by [ResolvedMedia].
     *
     * A 206 body must reach EOF at the end of its Content-Range; WebView is
     * not required to stop reading merely because Content-Length was set.
     */
    fun openStream(resolved: ResolvedMedia): InputStream? {
        val file = resolved.file ?: return null
        return runCatching {
            val stream = FileInputStream(file)
            stream.channel.position(resolved.offset)
            BoundedInputStream(stream, resolved.contentLength)
        }.getOrNull()
    }

    private class BoundedInputStream(
        input: InputStream,
        private var remaining: Long,
    ) : FilterInputStream(input) {
        override fun read(): Int {
            if (remaining <= 0) return -1
            val value = super.read()
            if (value >= 0) remaining--
            return value
        }

        override fun read(buffer: ByteArray, offset: Int, length: Int): Int {
            if (remaining <= 0) return -1
            val bounded = minOf(length.toLong(), remaining).toInt()
            val count = super.read(buffer, offset, bounded)
            if (count > 0) remaining -= count.toLong()
            return count
        }

        override fun skip(count: Long): Long {
            if (remaining <= 0) return 0
            val skipped = super.skip(minOf(count, remaining))
            remaining -= skipped
            return skipped
        }

        override fun available(): Int =
            minOf(super.available().toLong(), remaining, Int.MAX_VALUE.toLong()).toInt()
    }

    fun toResponse(resolved: ResolvedMedia): WebResourceResponse? {
        if (resolved.file == null) {
            if (resolved.statusCode != 416) return null
            return WebResourceResponse(
                "text/plain", "utf-8", 416, resolved.reason,
                mapOf("Content-Range" to (resolved.contentRange ?: "")),
                null,
            )
        }
        val stream = openStream(resolved) ?: return null
        return WebResourceResponse(
            resolved.mimeType, null,
            resolved.statusCode, resolved.reason,
            responseHeaders(resolved), stream,
        )
    }
}
