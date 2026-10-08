package org.tilecast.player.runtime

/** Authorizes intercepted `tcwidget://cap/<opaque-token>` frame loads.
 *
 * The URI carries an opaque per-activation token, never the digest or a
 * path: authorization is membership in the activation's frame token set.
 * The daemon verified the bytes before granting them; the interceptor
 * serves the grant's file.
 *
 * Unlike media, a `#fragment` is stripped, not refused: the executor
 * binds each attach with a handshake token in the fragment, and WebView
 * may pass it through to the interceptor. That handshake token
 * authenticates the frame handshake, never the HTTP layer, so the
 * resolver ignores it.
 */
object FrameAuthorization {
    data class AuthorizedFrame(val frameToken: String)

    fun authorize(rawUri: String?, authorized: Set<AuthorizedFrame>): AuthorizedFrame? {
        if (authorized.isEmpty()) return null
        val token = tokenOf(rawUri) ?: return null
        return authorized.firstOrNull { it.frameToken == token }
    }

    /** Extracts the opaque token from a `tcwidget://cap/<token>` URI. */
    fun tokenOf(rawUri: String?): String? {
        if (rawUri.isNullOrBlank()) return null
        val uri = rawUri.trim()
        if (uri.length > 512) return null
        if (uri.contains("\\") || uri.contains("\u0000") || uri.contains("..")) return null
        val bare = uri.substringBefore('#')
        val schemeEnd = bare.indexOf(':')
        if (schemeEnd <= 0) return null
        if (!bare.substring(0, schemeEnd).equals(SCHEME, ignoreCase = true)) return null
        var rest = bare.substring(schemeEnd + 1)
        while (rest.startsWith("/")) rest = rest.substring(1)
        if (!rest.startsWith("cap/")) return null
        val token = rest.removePrefix("cap/")
        if (token.isEmpty() || token.contains("?") || token.contains("/")) return null
        if (!isLowerHex(token)) return null
        return token
    }

    const val SCHEME = "tcwidget"

    private fun isLowerHex(value: String): Boolean =
        value.length == 64 && value.all { it in '0'..'9' || it in 'a'..'f' }
}
