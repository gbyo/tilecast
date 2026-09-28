package org.tilecast.player.runtime

/** App-owned HTTPS-style origin for the trusted Player Runtime WebView.
 *
 * The shared `packages/player-runtime/dist/runtime` document is served through
 * AndroidX `WebViewAssetLoader` on this origin. The trusted WebView must never
 * load `file://`, `data:` or remote URLs as its top-level document.
 */
object TrustedRuntimeOrigin {
    const val SCHEME = "https"
    const val HOST = "appassets.androidplatform.net"
    const val ASSET_LOADER_PATH_PREFIX = "/assets/"
    const val RUNTIME_PATH_PREFIX = "/assets/shared-runtime/"
    const val ENTRY_PAGE = "/assets/shared-runtime/index.html"

    val origin: String = "$SCHEME://$HOST"
    val entryUrl: String = "$SCHEME://$HOST$ENTRY_PAGE"

    /** True only for documents inside the packaged runtime directory. */
    fun isTrustedDocument(url: String?): Boolean {
        if (url.isNullOrBlank()) return false
        val normalized = url.trim()
        if (!normalized.startsWith(origin, ignoreCase = true)) return false
        val path = normalized.substring(origin.length)
        if (!path.startsWith(RUNTIME_PATH_PREFIX)) return false
        if (path.contains("..") || path.contains("\\") || path.contains("\u0000")) return false
        return true
    }

    /** Top-level navigation is allowed only within the trusted runtime tree. */
    fun allowsTopLevelNavigation(url: String?): Boolean = isTrustedDocument(url)
}
