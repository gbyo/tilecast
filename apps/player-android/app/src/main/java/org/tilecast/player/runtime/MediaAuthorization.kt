package org.tilecast.player.runtime

/** Host-authorized media access for the trusted runtime.
 *
 * The runtime receives only opaque `tcmedia:` URIs naming media the active
 * presentation already authorized. Raw filesystem paths, `content://`,
 * `file://` and any traversal payload never cross this boundary.
 */
object MediaAuthorization {
    const val SCHEME = "tcmedia"

    data class AuthorizedMedia(val assetId: String, val variantId: String)

    /** Resolves canonical `tcmedia://variant/<assetId>/<variantId>` and legacy direct URIs against the authorized set. */
    fun authorize(rawUri: String?, authorized: Set<AuthorizedMedia>): AuthorizedMedia? {
        if (rawUri.isNullOrBlank() || authorized.isEmpty()) return null
        val uri = rawUri.trim()
        if (uri.length > 512) return null
        if (uri.contains("\\") || uri.contains("\u0000") || uri.contains("..")) return null
        val schemeEnd = uri.indexOf(':')
        if (schemeEnd <= 0) return null
        if (!uri.substring(0, schemeEnd).equals(SCHEME, ignoreCase = true)) return null
        var rest = uri.substring(schemeEnd + 1)
        while (rest.startsWith("/")) rest = rest.substring(1)
        if (rest.isEmpty() || rest.contains("?") || rest.contains("#")) return null
        val rawParts = rest.split("/")
        val parts = if (rawParts.size == 3 && rawParts[0].equals("variant", ignoreCase = true)) {
            rawParts.drop(1)
        } else {
            rawParts
        }
        if (parts.size != 2) return null
        val (assetId, variantId) = parts
        if (!isToken(assetId) || !isToken(variantId)) return null
        val candidate = AuthorizedMedia(assetId, variantId)
        return candidate.takeIf { it in authorized }
    }

    private fun isToken(value: String): Boolean =
        value.isNotEmpty() && value.length <= 128 && value.matches(Regex("[A-Za-z0-9_-]+"))

    // ------------------------------------------------------------ ranges ----

    data class ByteRange(val start: Long, val endInclusive: Long)

    sealed interface RangeDecision {
        data class Full(val length: Long) : RangeDecision
        data class Partial(val range: ByteRange, val length: Long) : RangeDecision
        data class Unsatisfiable(val length: Long) : RangeDecision
        data class Invalid(val reason: String) : RangeDecision
    }

    /** Parses a single `Range: bytes=<start>-<end>` header against a known length. */
    fun decideRange(header: String?, length: Long): RangeDecision {
        if (length < 0) return RangeDecision.Invalid("unknown length")
        if (header.isNullOrBlank()) return RangeDecision.Full(length)
        val value = header.trim()
        if (!value.startsWith("bytes=")) return RangeDecision.Invalid("unsupported unit")
        val spec = value.removePrefix("bytes=").trim()
        if (spec.contains(",")) return RangeDecision.Invalid("multipart unsupported")
        if (spec.startsWith("-")) {
            val suffix = spec.drop(1).toLongOrNull() ?: return RangeDecision.Invalid("bad range")
            if (suffix <= 0) return RangeDecision.Invalid("bad range")
            if (length == 0L) return RangeDecision.Unsatisfiable(0)
            val start = (length - suffix).coerceAtLeast(0)
            return RangeDecision.Partial(ByteRange(start, length - 1), length)
        }
        val dash = spec.indexOf('-')
        if (dash <= 0) return RangeDecision.Invalid("bad range")
        val start = spec.substring(0, dash).toLongOrNull() ?: return RangeDecision.Invalid("bad range")
        if (start < 0) return RangeDecision.Invalid("bad range")
        val endText = spec.substring(dash + 1)
        if (endText.isEmpty()) {
            if (start >= length) return RangeDecision.Unsatisfiable(length)
            return RangeDecision.Partial(ByteRange(start, length - 1), length)
        }
        val endInclusive = endText.toLongOrNull() ?: return RangeDecision.Invalid("bad range")
        if (endInclusive < start) return RangeDecision.Invalid("bad range")
        if (start >= length) return RangeDecision.Unsatisfiable(length)
        return RangeDecision.Partial(ByteRange(start, minOf(endInclusive, length - 1)), length)
    }

    fun contentRangeHeader(range: ByteRange, length: Long): String =
        "bytes ${range.start}-${range.endInclusive}/$length"
}
