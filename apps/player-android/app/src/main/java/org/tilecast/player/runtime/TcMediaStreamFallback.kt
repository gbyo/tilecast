package org.tilecast.player.runtime

import android.webkit.WebResourceResponse
import okhttp3.OkHttpClient
import okhttp3.Request
import java.util.concurrent.TimeUnit

/** Host-side authenticated stream fallback for uncached media.
 *
 * `selectManifestDownloads` intentionally leaves `deliveryPolicy: "stream"`
 * (and large `automatic` videos) out of the cache, while the shared-runtime
 * builder addresses every image/video through `tcmedia:`. [TcMediaBridge]
 * only serves verified cache files, so without this fallback streamed items
 * have no playback path. This object proxies the WebView's request —
 * including its `Range` header — through an authenticated OkHttp call that
 * keeps the device credential in the Kotlin host: the runtime only ever
 * sees the opaque `tcmedia:` URI and the resulting bytes.
 */
object TcMediaStreamFallback {
    data class StreamTarget(
        val assetId: String,
        val variantId: String,
        val downloadPath: String,
        val mimeType: String,
    )

    private val sharedClient: OkHttpClient by lazy {
        OkHttpClient.Builder()
            .connectTimeout(10, TimeUnit.SECONDS)
            .readTimeout(30, TimeUnit.SECONDS)
            .build()
    }

    /** Pure target resolution: authorized `tcmedia:` URI to server path. */
    fun resolveTarget(
        rawUri: String?,
        authorized: Set<MediaAuthorization.AuthorizedMedia>,
        downloadPathByVariant: Map<String, String>,
        mimeByVariant: Map<String, String>,
    ): StreamTarget? {
        val media = MediaAuthorization.authorize(rawUri, authorized) ?: return null
        val path = downloadPathByVariant[media.variantId] ?: return null
        if (!path.startsWith("/")) return null
        return StreamTarget(
            media.assetId,
            media.variantId,
            path,
            mimeByVariant[media.variantId] ?: "application/octet-stream",
        )
    }

    /** Pure request construction: credential stays in a header, Range passes through. */
    internal fun buildRequest(
        serverUrl: String,
        credential: String,
        target: StreamTarget,
        rangeHeader: String?,
    ): Request? {
        if (serverUrl.isBlank() || credential.isBlank()) return null
        return Request.Builder()
            .url(serverUrl.trimEnd('/') + target.downloadPath)
            .header("Authorization", "Bearer $credential")
            .apply {
                // Forward the player's seek: the server honors Range on
                // variant downloads, so video start offsets keep working.
                if (!rangeHeader.isNullOrBlank()) header("Range", rangeHeader.trim())
            }
            .get()
            .build()
    }

    /** Pure header mapping for the proxied response. */
    internal fun responseHeaders(
        target: StreamTarget,
        contentLength: String?,
        contentRange: String?,
    ): Map<String, String> {
        val headers = mutableMapOf(
            "Accept-Ranges" to "bytes",
            "Content-Type" to target.mimeType,
        )
        contentLength?.let { headers["Content-Length"] = it }
        contentRange?.let { headers["Content-Range"] = it }
        return headers
    }

    /**
     * Blocking fetch for `shouldInterceptRequest` (which runs off the UI
     * thread). Returns null when the URI is not authorized, the variant is
     * unknown, credentials are missing, or the server refuses; the caller
     * then fails closed like any other unresolvable item.
     */
    fun fetch(
        serverUrl: String,
        credential: String,
        rawUri: String?,
        authorized: Set<MediaAuthorization.AuthorizedMedia>,
        downloadPathByVariant: Map<String, String>,
        mimeByVariant: Map<String, String>,
        rangeHeader: String?,
        client: OkHttpClient = sharedClient,
    ): WebResourceResponse? {
        val target = resolveTarget(rawUri, authorized, downloadPathByVariant, mimeByVariant) ?: return null
        val request = buildRequest(serverUrl, credential, target, rangeHeader) ?: return null
        val response = runCatching { client.newCall(request).execute() }.getOrNull() ?: return null
        if (!response.isSuccessful) {
            runCatching { response.close() }
            return null
        }
        val body = response.body
        if (body == null) {
            runCatching { response.close() }
            return null
        }
        // Body ownership passes to WebView with the stream; it closes it.
        return WebResourceResponse(
            target.mimeType, null,
            response.code, reasonFor(response.code),
            responseHeaders(target, response.header("Content-Length"), response.header("Content-Range")),
            body.byteStream(),
        )
    }

    internal fun reasonFor(code: Int): String = when (code) {
        200 -> "OK"
        206 -> "Partial Content"
        else -> "OK"
    }
}
