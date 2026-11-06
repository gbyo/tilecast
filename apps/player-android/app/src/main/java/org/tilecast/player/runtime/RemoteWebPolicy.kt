package org.tilecast.player.runtime

import java.net.URI
import org.tilecast.player.runtime.RemoteWebHostManager.PageContent

/** Main-frame navigation allowlist for a remote page surface. */
object RemoteWebNavigationPolicy {
    /**
     * A target is allowed when it is https (or http, only for a page that was
     * itself http), has no user information, uses the scheme's default port,
     * and names one of the page's allowed hosts exactly.
     */
    fun allows(raw: String?, page: PageContent): Boolean {
        if (raw == null) return false
        val target = runCatching { URI(raw) }.getOrNull() ?: return false
        val origin = runCatching { URI(page.url) }.getOrNull() ?: return false
        if (target.isOpaque || target.userInfo != null) return false
        val scheme = target.scheme?.lowercase() ?: return false
        val originScheme = origin.scheme?.lowercase()
        if (scheme != "https" && !(scheme == "http" && originScheme == "http")) return false
        val port = target.port
        if (port != -1 && port != if (scheme == "https") 443 else 80) return false
        val host = target.host?.let(RemoteWebHostManager::normalizeHost) ?: return false
        return page.allowedHosts.any { RemoteWebHostManager.normalizeHost(it) == host }
    }

    /** The host to name in a `navigation-blocked` event, or null when there is none. */
    fun blockedHost(raw: String?): String? =
        raw?.let { runCatching { URI(it).host }.getOrNull() }?.takeIf { it.isNotBlank() }?.take(63)
}

/** Stable reason tokens for remote web failures. */
object RemoteWebFailure {
    const val HTTP_ERROR = "http_error"
    const val TLS_FAILURE = "tls_failure"
    const val RENDERER_CRASH = "renderer_crash"

    /** Maps `WebViewClient.ERROR_*` (literal values; the constants are plain ints). */
    fun forLoadError(errorCode: Int): String = when (errorCode) {
        -2 -> "dns_failure" // ERROR_HOST_LOOKUP
        -6 -> "connection_failure" // ERROR_CONNECT
        -8 -> "load_timeout" // ERROR_TIMEOUT
        -11 -> TLS_FAILURE // ERROR_FAILED_SSL_HANDSHAKE
        -10 -> "unsupported_scheme" // ERROR_UNSUPPORTED_SCHEME
        else -> "unknown_webview_error"
    }

    fun isMainFrameHttpFailure(statusCode: Int): Boolean = statusCode >= 400
}

/** Page background colors as the runtime sends them: `#RRGGBB` or `#RRGGBBAA`. */
object RemoteWebColor {
    /** An Android ARGB int, or null for anything else. */
    fun parse(value: String): Int? {
        if (!Regex("#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})").matches(value)) return null
        val rgb = value.substring(1, 7).toLong(16)
        val alpha = if (value.length == 9) value.substring(7, 9).toLong(16) else 0xFFL
        return ((alpha shl 24) or rgb).toInt()
    }
}

object RemoteWebZoom {
    /**
     * The value for `WebView.setInitialScale`, which counts physical pixels
     * rather than density-independent ones; 0 keeps the engine default.
     */
    fun initialScale(zoomPercent: Int, density: Float): Int =
        if (zoomPercent == 100 || density <= 0f) 0 else Math.round(zoomPercent * density)
}
