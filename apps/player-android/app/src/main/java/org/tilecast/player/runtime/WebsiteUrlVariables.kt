package org.tilecast.player.runtime

import java.net.URL
import java.net.URLDecoder
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
        if (!template.contains("{") && !template.contains("%7B", ignoreCase = true)) return template
        val beforeQuery = template.substringBefore('?')
        val fragment = template.substringAfter('#', "")
        if (beforeQuery.contains('{') || beforeQuery.contains('}') ||
            fragment.contains('{') || fragment.contains('}') ||
            beforeQuery.contains("%7B", ignoreCase = true) ||
            beforeQuery.contains("%7D", ignoreCase = true)) return null
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
        fun valueFor(key: String): String? = when (key) {
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
            val decodedName = runCatching { URLDecoder.decode(name, "UTF-8") }.getOrNull()
                ?: return null
            if ('{' in decodedName || '}' in decodedName) return null
            val decoded = runCatching { URLDecoder.decode(raw, "UTF-8") }.getOrNull()
                ?: return null
            if (!decoded.contains('{') && !decoded.contains('}')) return@map part
            // Braces in JSON expansion are data, not unresolved tokens.
            if ('{' in decoded.replace(token, "") || '}' in decoded.replace(token, "")) return null
            var invalid = false
            val replaced = token.replace(decoded) { result ->
                valueFor(result.groupValues[1]) ?: run {
                    invalid = true
                    ""
                }
            }
            if (invalid) return null
            "${name}=${URLEncoder.encode(replaced, StandardCharsets.UTF_8.name())}"
        }
        val answer = beforeQuery + "?" + parts.joinToString("&") +
            if (template.contains('#')) "#" + fragment else ""
        return answer.takeIf { it.length <= 2048 }
    }

    private fun scalar(value: DocumentValue): String = when (value.kind) {
        "text" -> value.text.orEmpty()
        "number" -> value.number?.toString().orEmpty()
        "integer" -> value.integer?.toString().orEmpty()
        "boolean" -> value.boolean?.toString().orEmpty()
        "date" -> value.date.orEmpty()
        "datetime" -> value.datetime.orEmpty()
        "url" -> value.url.orEmpty()
        else -> value.text.orEmpty()
    }

    private fun records(source: ManifestDataSource): List<Map<String, String>> {
        val document = source.dataDocument?.datasets?.firstOrNull { it.kind == "records" }
        if (document != null) {
            if (document.cache.unavailable) return emptyList()
            return document.records.take(100).map { record ->
                record.values.mapValues { scalar(it.value) }
            }
        }
        // Schema 12 manual/typed data sources have records in configuration.
        val raw = source.configuration["records"] as? JsonArray ?: return emptyList()
        return raw.take(100).mapNotNull { record ->
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
