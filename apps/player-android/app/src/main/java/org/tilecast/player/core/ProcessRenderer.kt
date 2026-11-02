package org.tilecast.player.core

import android.content.Context
import android.view.ViewGroup
import android.webkit.WebView
import androidx.webkit.WebViewCompat
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch
import org.tilecast.player.BuildConfig

/**
 * What the visible Activity contributes to the renderer: the window capture
 * source and the sensitive-surface check. Both belong to the window, not to
 * the renderer, so they are attached and detached with the Activity.
 */
interface RendererPresentation {
    /** Names why the current screen must never be captured, or null. */
    fun captureBlockReason(): String?

    suspend fun capture(maxWidth: Int, maxHeight: Int, maxBytes: Int): WebViewCoreRenderer.CapturedImage?
}

/**
 * The one trusted-runtime renderer of this process.
 *
 * The WebView is created with the application context, so it does not need an
 * Activity, and its lifetime is the process: Activity recreation, task
 * restarts, and warm launches attach and detach the same view and never
 * create, close, or renumber a renderer. The renderer's generation comes from
 * the process-wide allocator and its Core connection is owned by the
 * application-scoped [PlayerCoreHost]. A renderer-process death still gets a
 * fresh generation through the renderer's own recovery.
 */
object ProcessRenderer {
    @Volatile
    private var instance: WebViewCoreRenderer? = null

    @Volatile
    private var presentation: RendererPresentation? = null

    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)

    fun get(context: Context): WebViewCoreRenderer =
        instance ?: synchronized(this) {
            instance ?: build(context.applicationContext).also { instance = it }
        }

    /** Attaches the visible Activity's window services. */
    fun attachPresentation(next: RendererPresentation) {
        presentation = next
    }

    /** Detaches [current] only if it is still the attached one; a replacement Activity may already own it. */
    fun detachPresentation(current: RendererPresentation) {
        if (presentation === current) presentation = null
    }

    /**
     * Removes the WebView from whatever parent holds it. Called before a new
     * Activity adopts the view and when the old one goes away, so a view can
     * never be left parented to a destroyed window.
     */
    fun releaseView(view: WebView?) {
        (view?.parent as? ViewGroup)?.removeView(view)
    }

    /** Releases [view] only while it still hangs in [ownedBy]'s window, so a replacement Activity keeps it. */
    fun releaseView(view: WebView?, ownedBy: android.view.View) {
        if (view != null && view.rootView === ownedBy) releaseView(view)
    }

    private fun build(app: Context): WebViewCoreRenderer {
        val host = PlayerCoreHost.get(app)
        val renderer = WebViewCoreRenderer(
            app,
            BuildConfig.VERSION_NAME,
            WebViewCompat.getCurrentWebViewPackage(app)?.versionName ?: "unknown",
            report = { json -> host.rendererReport(json) },
            captureFrame = { maxWidth, maxHeight, maxBytes ->
                presentation?.capture(maxWidth, maxHeight, maxBytes)
            },
            captureBlockReason = { presentation?.captureBlockReason() ?: "display_host_detached" },
            onCapabilitiesChanged = {
                scope.launch {
                    runCatching { host.syncManifest() }
                    runCatching { host.refreshStatus() }
                }
            },
            awaitCoreReady = { host.awaitReady() },
        )
        host.attachRendererAdapter(renderer)
        AndroidRendererLog.event("renderer_owner_created", emptyMap())
        return renderer
    }
}
