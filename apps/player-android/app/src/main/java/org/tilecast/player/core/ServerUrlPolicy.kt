package org.tilecast.player.core

import java.net.URI

data class NormalizedServerUrl(val value: String, val localInsecure: Boolean)

object ServerUrlPolicy {
    fun normalize(input: String): Result<NormalizedServerUrl> = runCatching {
        var candidate = input.trim()
        if (!candidate.contains("://")) candidate = "https://$candidate"
        val uri = URI(candidate)
        val scheme = uri.scheme?.lowercase() ?: error("Enter an HTTP or HTTPS server address")
        require(scheme == "http" || scheme == "https") { "Only HTTP and HTTPS addresses are supported" }
        require(uri.host != null && uri.userInfo == null && uri.query == null && uri.fragment == null) { "Enter a valid server address" }
        require(uri.path.isNullOrEmpty() || uri.path == "/") { "The server address cannot include a path" }
        val host = uri.host.lowercase()
        val localHttp = scheme == "http" && isLocalHost(host)
        require(scheme == "https" || localHttp) { "Public Tilecast servers require HTTPS" }
        val displayHost = if (host.contains(":")) "[$host]" else host
        val port = if (uri.port > 0) ":${uri.port}" else ""
        NormalizedServerUrl("$scheme://$displayHost$port", localHttp)
    }

    /**
     * Completes an address typed with a remote. A bare private-network or
     * `.local` host means the installer's own LAN server, so it gets HTTP;
     * anything else is left for [normalize], which defaults to HTTPS. An
     * address that names a scheme is returned unchanged, so this never
     * turns HTTPS into HTTP.
     */
    fun withDefaultScheme(input: String): String {
        val trimmed = input.trim()
        if (trimmed.isEmpty() || trimmed.contains("://")) return trimmed
        val host = runCatching { URI("http://$trimmed").host }.getOrNull()?.lowercase() ?: return trimmed
        return if (isLocalHost(host)) "http://$trimmed" else trimmed
    }

    private fun isLocalHost(host: String): Boolean {
        if (host == "localhost" || host.endsWith(".local")) return true
        val parts = host.split('.').mapNotNull { it.toIntOrNull() }
        if (parts.size == 4 && parts.all { it in 0..255 }) {
            return parts[0] == 10 ||
                (parts[0] == 172 && parts[1] in 16..31) ||
                (parts[0] == 192 && parts[1] == 168) ||
                (parts[0] == 169 && parts[1] == 254) ||
                parts[0] == 127
        }
        return host == "::1" || host.startsWith("fe80:")
    }
}

