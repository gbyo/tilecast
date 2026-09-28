package org.tilecast.player.runtime

/** Host-owned remote-web (`remoteWeb: "host-view"`) surface management.
 *
 * Remote Website/YouTube content renders in host-owned WebViews that never
 * receive the trusted-runtime bridge. The shared runtime owns policy and
 * lifecycle orchestration; this manager tracks surface state, validates
 * specs, maps viewports into pixels, and rejects stale generations. Actual
 * WebView creation lives in the Compose layer ([RuntimeStage]).
 */
object RemoteWebHostManager {
    const val SURFACE_ID_PATTERN = "[a-z0-9-]{1,48}"

    data class Viewport(val x: Double, val y: Double, val width: Double, val height: Double, val deviceScale: Double)

    data class PageContent(
        val url: String,
        val allowedHosts: List<String>,
        val javascriptEnabled: Boolean,
        val domStorageEnabled: Boolean,
        val cookiePolicy: String,
        val userAgent: String,
        val zoomPercent: Int,
        val scrollX: Int,
        val scrollY: Int,
        val backgroundColor: String,
    )

    data class YouTubeContent(
        val videoId: String?,
        val playlistId: String?,
        val startSeconds: Int,
        val endSeconds: Int?,
        val loop: Boolean,
        val muted: Boolean,
        val volume: Int,
        val captions: Boolean,
        val captionLanguage: String,
        val controls: Boolean,
    )

    data class Surface(
        val surfaceId: String,
        val page: PageContent?,
        val youTube: YouTubeContent?,
        val viewportPx: ViewportPx,
        val muted: Boolean,
        val visible: Boolean,
        val reloadCount: Int,
        val generation: Long,
    )

    data class ViewportPx(val x: Int, val y: Int, val width: Int, val height: Int)

    /** CSS-pixel viewport plus deviceScale into integer Android pixels, clipped at zero. */
    fun mapViewport(viewport: Viewport): ViewportPx? {
        if (!viewport.x.isFinite() || !viewport.y.isFinite() ||
            !viewport.width.isFinite() || !viewport.height.isFinite() ||
            !viewport.deviceScale.isFinite()
        ) return null
        if (viewport.deviceScale <= 0.0) return null
        if (viewport.width <= 0.0 || viewport.height <= 0.0) return null
        val scale = viewport.deviceScale
        // Negative origins are legal: the runtime clips partially offscreen surfaces.
        val x = (viewport.x * scale).toInt()
        val y = (viewport.y * scale).toInt()
        val width = (viewport.width * scale).toInt().coerceAtLeast(0)
        val height = (viewport.height * scale).toInt().coerceAtLeast(0)
        if (width <= 0 || height <= 0) return null
        return ViewportPx(x, y, width, height)
    }

    fun validSurfaceId(surfaceId: String): Boolean =
        surfaceId.matches(Regex(SURFACE_ID_PATTERN))

    /** Page policy check mirroring the trusted remote-web contract. */
    fun validPage(page: PageContent): Boolean {
        if (page.allowedHosts.isEmpty() || page.allowedHosts.size > 25) return false
        if (page.allowedHosts.any { it.isBlank() || it.length > 253 }) return false
        val uri = runCatching { java.net.URI(page.url) }.getOrNull() ?: return false
        if (uri.userInfo != null || uri.host.isNullOrBlank()) return false
        val scheme = uri.scheme?.lowercase() ?: return false
        if (scheme != "https" && scheme != "http") return false
        val port = uri.port
        if (port != -1 && port != 443 && port != 80) return false
        if (page.cookiePolicy !in setOf("disabled", "first_party", "first_and_third_party")) return false
        if (page.zoomPercent !in 25..400) return false
        return true
    }

    /** Exactly one of videoId/playlistId, per contract. */
    fun validYouTube(content: YouTubeContent): Boolean {
        val hasVideo = !content.videoId.isNullOrBlank()
        val hasPlaylist = !content.playlistId.isNullOrBlank()
        if (hasVideo == hasPlaylist) return false
        if (content.startSeconds < 0) return false
        if (content.endSeconds != null && content.endSeconds < 0) return false
        if (content.volume !in 0..100) return false
        return true
    }

    /** Tracks live surfaces across one runtime generation; stale generations are dropped. */
    class Tracker(private var generation: Long) {
        private val surfaces = LinkedHashMap<String, Surface>()

        fun create(surface: Surface): Boolean {
            if (surface.generation != generation) return false
            if (!validSurfaceId(surface.surfaceId)) return false
            if ((surface.page == null) == (surface.youTube == null)) return false
            surface.page?.let { if (!validPage(it)) return false }
            surface.youTube?.let { if (!validYouTube(it)) return false }
            surfaces[surface.surfaceId] = surface
            return true
        }

        fun updateViewport(surfaceId: String, viewportPx: ViewportPx, generation: Long): Boolean {
            if (generation != this.generation) return false
            val current = surfaces[surfaceId] ?: return false
            surfaces[surfaceId] = current.copy(viewportPx = viewportPx)
            return true
        }

        fun setVisible(surfaceId: String, visible: Boolean, generation: Long): Boolean {
            if (generation != this.generation) return false
            val current = surfaces[surfaceId] ?: return false
            surfaces[surfaceId] = current.copy(visible = visible)
            return true
        }

        fun setMuted(surfaceId: String, muted: Boolean, generation: Long): Boolean {
            if (generation != this.generation) return false
            val current = surfaces[surfaceId] ?: return false
            surfaces[surfaceId] = current.copy(muted = muted)
            return true
        }

        fun reload(surfaceId: String, generation: Long): Boolean {
            if (generation != this.generation) return false
            val current = surfaces[surfaceId] ?: return false
            surfaces[surfaceId] = current.copy(reloadCount = current.reloadCount + 1)
            return true
        }

        fun destroy(surfaceId: String, generation: Long): Boolean {
            if (generation != this.generation) return false
            return surfaces.remove(surfaceId) != null
        }

        /** Drops every surface of a replaced presentation generation. */
        fun reset(generation: Long): List<String> {
            val removed = surfaces.keys.toList()
            surfaces.clear()
            this.generation = generation
            return removed
        }

        fun snapshot(): List<Surface> = surfaces.values.toList()
    }
}
