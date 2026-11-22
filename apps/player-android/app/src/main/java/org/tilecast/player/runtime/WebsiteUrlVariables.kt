package org.tilecast.player.runtime

import java.math.BigDecimal
import java.net.URL
import java.net.URLEncoder
import java.nio.charset.StandardCharsets
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import org.tilecast.player.network.DocumentValue
import org.tilecast.player.network.ManifestDataSource

/**
 * Website variables expand only in query values. Missing values fail closed
 * rather than navigating with literal braces or constructing a new host.
 */
internal object WebsiteUrlVariables {
    private val token = Regex("""\{([a-zA-Z][a-zA-Z0-9_.:-]*)\}""")
    private val nameBraces = Regex("""[{}]|%7[bBdD]""")
    private val field = Regex("""([a-zA-Z_][a-zA-Z0-9_-]*)(?::([0-9]{1,3}))?""")
    private val dateFormat = DateTimeFormatter.ofPattern("yyyy-MM-dd")
    private val timeFormat = DateTimeFormatter.ofPattern("HH:mm:ss")

    fun resolve(
        template: String,
        screenId: String,
        at: Instant = Instant.now(),
        dataSourceId: String? = null,
        sources: List<ManifestDataSource> = emptyList(),
    ): String? {
        // An encoded JSON value is static URL data, not a template token.
        if (!template.contains("{")) return template
        val beforeQuery = template.substringBefore('?')
        val fragment = template.substringAfter('#', "")
        val queryStart = template.indexOf('?')
        val fragmentStart = template.indexOf('#')
        if (beforeQuery.contains('{') || beforeQuery.contains('}') ||
            fragment.contains('{') || fragment.contains('}') ||
            queryStart < 0 || (fragmentStart >= 0 && fragmentStart < queryStart)) return null
        val parsed = runCatching { URL(template) }.getOrNull() ?: return null
        if (parsed.protocol !in listOf("http", "https") || parsed.host.isBlank() ||
            parsed.userInfo != null) return null
        val query = template.substringAfter('?', "").substringBefore('#')
        if (query.isBlank()) return null
        val local = at.atZone(ZoneId.systemDefault())
        val date = local.format(dateFormat)
        val time = local.format(timeFormat)
        val source = sources.firstOrNull { it.id == dataSourceId }
        val rows = source?.let(::records) ?: emptyList()
        val obj = source?.let(::objectValues) ?: emptyMap()
        // The shared resolver applies a Data Source's date selection before it
        // picks records. Android has no selector, so a selecting source fails
        // closed instead of resolving different records than other Players.
        val selects = source?.let(::selectsByDate) ?: false
        fun valueFor(key: String): String? = if (key.startsWith("data.") && selects) null else when (key) {
            "screen.id" -> screenId
            "date" -> date
            "time" -> time
            "datetime" -> "${date}T${time}"
            "data.json" -> when {
                source == null -> null
                rows.isNotEmpty() -> JsonArray(rows.map { row ->
                    JsonObject(row.mapValues { JsonPrimitive(it.value) })
                }).toString()
                obj.isNotEmpty() -> JsonObject(obj.mapValues { JsonPrimitive(it.value) }).toString()
                else -> null
            }
            "data.values" -> if (rows.isEmpty()) null else {
                val first = rows.first().keys.firstOrNull()
                if (first == null) null
                else JsonArray(rows.map { JsonPrimitive(it[first] ?: "") }).toString()
            }
            else -> {
                if (!key.startsWith("data.") || source == null) null
                else {
                    val match = field.matchEntire(key.removePrefix("data."))
                    if (match == null) null
                    else {
                        val index = match.groupValues[2].toIntOrNull() ?: 0
                        val name = match.groupValues[1]
                        if (rows.isNotEmpty()) rows.getOrNull(index)?.get(name)
                        else if (index == 0) obj[name] else null
                    }
                }
            }
        }
        val parts = query.split('&').map { part ->
            val name = part.substringBefore('=')
            val raw = part.substringAfter('=', "")
            // Match the shared resolver: braces in a name, literal or
            // percent-encoded, are refused; a stray '%' is not an error.
            if (nameBraces.containsMatchIn(name)) return null
            if ('{' !in raw && '}' !in raw) return@map part
            val literals = raw.replace(token, "")
            if ('{' in literals || '}' in literals) return null
            var invalid = false
            val replaced = token.replace(raw) { result ->
                valueFor(result.groupValues[1])?.let(::encodeComponent) ?: run {
                    invalid = true
                    ""
                }
            }
            if (invalid) return null
            "${name}=${replaced}"
        }
        val answer = beforeQuery + "?" + parts.joinToString("&") +
            if (template.contains('#')) "#" + fragment else ""
        return answer.takeIf { it.length <= 2048 }
    }

    // Mirrors docValueToRaw in the shared resolver so each host emits the same text.
    private fun scalar(value: DocumentValue): String = when (value.kind) {
        "text" -> value.text.orEmpty()
        "number", "percent", "currency" -> (value.number?.let(::plainNumber) ?: value.integer?.toString()).orEmpty()
        "integer" -> value.integer?.toString().orEmpty()
        "boolean" -> value.boolean?.toString().orEmpty()
        "date" -> value.date.orEmpty()
        "datetime" -> value.datetime.orEmpty()
        "duration" -> value.durationSeconds?.toString().orEmpty()
        "url" -> value.url.orEmpty()
        "asset" -> value.assetId.orEmpty()
        else -> value.text.orEmpty()
    }

    /** JavaScript's `String(number)`: no trailing ".0" and no exponent for ordinary values. */
    private fun plainNumber(value: Double): String =
        if (!value.isFinite()) value.toString()
        else BigDecimal(value.toString()).stripTrailingZeros().toPlainString()

    /** `encodeURIComponent`: percent-encode everything but letters, digits and -_.!~*'() */
    private fun encodeComponent(value: String): String =
        URLEncoder.encode(value, StandardCharsets.UTF_8.name())
            .replace("+", "%20").replace("%21", "!").replace("%27", "'")
            .replace("%28", "(").replace("%29", ")").replace("%7E", "~")

    private fun selectsByDate(source: ManifestDataSource): Boolean {
        val datasets = source.dataDocument?.datasets.orEmpty()
        if (datasets.any { it.dateSelection != null }) return true
        val selection = (source.configuration["data"] as? JsonObject)
            ?.get("dateSelection") as? JsonObject
        return (selection?.get("enabled") as? JsonPrimitive)?.content == "true"
    }

    private fun records(source: ManifestDataSource): List<Map<String, String>> {
        val datasets = source.dataDocument?.datasets.orEmpty()
        val document = datasets.firstOrNull { it.kind == "records" }
            ?: datasets.firstOrNull { it.records.isNotEmpty() }
        if (document != null) {
            if (document.cache.unavailable) return emptyList()
            return document.records.map { record ->
                record.values.mapValues { scalar(it.value) }
            }
        }
        // Schema 12 manual/typed data sources have records in configuration.
        if ((source.configuration["unavailable"] as? JsonPrimitive)?.content == "true") return emptyList()
        val raw = source.configuration["records"] as? JsonArray ?: return emptyList()
        return raw.mapNotNull { record ->
            val values = (record as? JsonObject)?.get("values") as? JsonObject
                ?: return@mapNotNull null
            values.mapValues { (_, v) -> (v as? JsonPrimitive)?.content.orEmpty() }
        }
    }

    private fun objectValues(source: ManifestDataSource): Map<String, String> {
        val document = source.dataDocument?.datasets?.firstOrNull { it.kind == "object" }
            ?: return emptyMap()
        if (document.cache.unavailable) return emptyMap()
        return document.value?.objectValue?.mapValues { scalar(it.value) } ?: emptyMap()
    }
}
