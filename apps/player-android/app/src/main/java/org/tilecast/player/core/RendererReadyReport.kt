package org.tilecast.player.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.tilecast.player.network.PresentationCapabilities
import org.tilecast.player.runtime.RuntimeSupport
import org.tilecast.player.runtime.RuntimeSupportAssessment
import org.tilecast.player.runtime.WidgetComponentCapabilities

/**
 * The `ready` report a live renderer sends Core: what the installed WebView
 * actually proved it can run.
 *
 * Every list comes from a generated definition. Features, schemas, and the
 * host-provided capabilities come from `apps/player-android/renderer-profile.json`;
 * the declarative table from the shared presentation capability contract; the
 * Widget components from the Widget manifests. The native crate prepares
 * manifests against the packaged profile built from the same sources, so the
 * two can differ only by what a WebView could not prove: never by a list that
 * someone updated on one side.
 */
object RendererReadyReport {
    fun build(generation: Long, support: RuntimeSupport): String {
        val schemas = RuntimeSupportAssessment.schemasFor(support)
        return buildJsonObject {
            put("type", "ready")
            put("generation", generation)
            put(
                "report",
                buildJsonObject {
                    put("features", JsonArray(RendererProfile.FEATURES.map { JsonPrimitive(it) }))
                    put(
                        "support",
                        buildJsonObject {
                            put("presentationSchemas", JsonArray(schemas.map { JsonPrimitive(it) }))
                            put("declarativeCapabilities", declarativeCapabilities(support))
                            put("widgetComponents", widgetComponents(support))
                        },
                    )
                },
            )
        }.toString()
    }

    /**
     * An untrusted runtime advertises nothing: the server must not negotiate
     * content this build cannot render.
     */
    fun declarativeCapabilities(support: RuntimeSupport): JsonObject =
        buildJsonObject {
            if (!support.trustedRuntimeSupported) return@buildJsonObject
            for ((name, version) in PresentationCapabilities.SHARED_RUNTIME_DECLARATIVE_PRESENTATION_CAPABILITIES) {
                put(name, version)
            }
            put(RendererProfile.WEB_REMOTE_CAPABILITY, RendererProfile.WEB_REMOTE_VERSION)
            // Plugin API v2: the same shared Runtime hosts it on this WebView,
            // with the services the generated contract names. A host-assisted
            // service such as player.events is not in that list.
            put(RendererProfile.PLUGIN_HOST_CAPABILITY, RendererProfile.PLUGIN_HOST_VERSION)
            for ((name, version) in RendererProfile.SHARED_RUNTIME_PLAYER_SERVICES) {
                put(name, version)
            }
        }

    fun widgetComponents(support: RuntimeSupport): JsonObject =
        buildJsonObject {
            if (!support.componentRuntimeSupported) return@buildJsonObject
            for ((name, version) in WidgetComponentCapabilities.WIDGET_COMPONENT_CAPABILITIES) {
                put(name, version)
            }
            // The frame execution ABI is one capability for every downloaded
            // Widget, not a discovered component: this release confines
            // served frames, so it offers it.
            put(RendererProfile.EXTERNAL_WIDGET_RUNTIME_CAPABILITY, RendererProfile.EXTERNAL_WIDGET_RUNTIME_VERSION)
        }
}
