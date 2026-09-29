package org.tilecast.player.runtime

import androidx.webkit.WebViewFeature

/**
 * Shared-runtime support assessment (Android PR3 step 9).
 *
 * Android API level alone never proves the installed WebView can render the
 * shared Player Runtime: the WebView implementation updates independently.
 * [trustedRuntimeSupported] verifies the bridge APIs the host implementation
 * actually needs (Jetpack WebKit feature detection, matching
 * TrustedRuntimeWebView's requirement). [componentRuntimeSupported] additionally
 * requires the app-owned Widget V2 runtime probe to have passed; WebView
 * package/version is diagnostics only and never gates support.
 */
data class RuntimeSupport(
    val trustedRuntimeSupported: Boolean,
    val componentRuntimeSupported: Boolean,
)

object RuntimeSupportAssessment {
    fun assess(
        isFeatureSupported: (String) -> Boolean = WebViewFeature::isFeatureSupported,
        componentProbePassed: Boolean = false,
    ): RuntimeSupport {
        val trusted = runCatching {
            isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER) &&
                isFeatureSupported(WebViewFeature.DOCUMENT_START_SCRIPT)
        }.getOrDefault(false)
        return RuntimeSupport(
            trustedRuntimeSupported = trusted,
            componentRuntimeSupported = trusted && componentProbePassed,
        )
    }

    /**
     * No fallback renderer exists, so an untrusted runtime advertises
     * nothing: the server must not negotiate content this build cannot
     * render.
     */
    fun schemasFor(support: RuntimeSupport): List<Int> =
        if (!support.trustedRuntimeSupported) emptyList()
        else if (support.componentRuntimeSupported) listOf(1, 2) else listOf(1)

    fun nativeCapabilitiesFor(
        support: RuntimeSupport,
        legacy: Map<String, Int> = org.tilecast.player.network.PlayerPresentationSupport.native,
        generated: Map<String, Int> = WidgetComponentCapabilities.WIDGET_COMPONENT_CAPABILITIES,
    ): Map<String, Int> =
        if (!support.trustedRuntimeSupported) emptyMap()
        else if (support.componentRuntimeSupported) legacy + generated else legacy
}
