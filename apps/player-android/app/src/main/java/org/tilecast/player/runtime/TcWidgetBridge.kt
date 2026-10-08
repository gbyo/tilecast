package org.tilecast.player.runtime

import android.webkit.WebResourceResponse
import java.io.File
import java.io.FileInputStream
import java.io.InputStream

/** Turns authorized frame grants into intercepted WebView responses.
 *
 * Frames serve whole documents only, confined by the shared sandbox
 * policy: any Range answers 416 because a partial frame can never
 * execute. Unknown tokens, missing files, and size mismatches answer
 * null (the WebView's 404 path), exactly like ungranted media.
 */
object TcWidgetBridge {
    const val SANDBOX_POLICY = "sandbox allow-scripts"

    data class ResolvedFrame(
        val statusCode: Int,
        val reason: String,
        val contentLength: Long,
        val contentRange: String?,
        val file: File?,
    )

    fun resolve(
        rawUri: String?,
        authorized: Set<FrameAuthorization.AuthorizedFrame>,
        localFiles: Map<String, String>,
        rangeHeader: String?,
    ): ResolvedFrame? {
        val frame = FrameAuthorization.authorize(rawUri, authorized) ?: return null
        val file = localFiles[frame.frameToken]?.let(::File)?.takeIf { it.isFile } ?: return null
        val length = file.length()
        if (!rangeHeader.isNullOrBlank()) {
            return ResolvedFrame(416, "Range Not Satisfiable", 0, "bytes */$length", null)
        }
        return ResolvedFrame(200, "OK", length, null, file)
    }

    fun responseHeaders(resolved: ResolvedFrame): Map<String, String> {
        val headers = mutableMapOf(
            "Content-Length" to resolved.contentLength.toString(),
            "Content-Type" to "text/html",
            "Content-Security-Policy" to SANDBOX_POLICY,
            "X-Content-Type-Options" to "nosniff",
            "Accept-Ranges" to "none",
            "Cache-Control" to "no-store",
        )
        resolved.contentRange?.let { headers["Content-Range"] = it }
        return headers
    }

    fun openStream(resolved: ResolvedFrame): InputStream? {
        val file = resolved.file ?: return null
        return runCatching { FileInputStream(file) }.getOrNull()
    }

    fun toResponse(resolved: ResolvedFrame): WebResourceResponse? {
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
            "text/html", "utf-8", resolved.statusCode, resolved.reason,
            responseHeaders(resolved), stream,
        )
    }
}
