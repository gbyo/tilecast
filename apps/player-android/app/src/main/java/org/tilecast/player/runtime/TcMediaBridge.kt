package org.tilecast.player.runtime

import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream

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

    fun openStream(resolved: ResolvedMedia): FileInputStream? {
        val file = resolved.file ?: return null
        return runCatching {
            FileInputStream(file).also { it.skip(resolved.offset) }
        }.getOrNull()
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
