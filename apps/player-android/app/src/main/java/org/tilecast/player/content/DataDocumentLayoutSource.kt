package org.tilecast.player.content

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.decodeFromJsonElement
import org.tilecast.player.network.DataDocument
import org.tilecast.player.network.DateSelection
import org.tilecast.player.network.DocumentDataset
import org.tilecast.player.network.DocumentRecord
import org.tilecast.player.network.DocumentValue
import org.tilecast.player.network.ManifestDataSource
import org.tilecast.player.network.StructuredPreparedData
import org.tilecast.player.network.StructuredRecord
import org.tilecast.player.network.StructuredSourceConfig
import org.tilecast.player.network.TypedRecord
import org.tilecast.player.network.TypedRecordData

internal fun ManifestDataSource.toLayoutStructuredSource(): StructuredSourceConfig? {
    val dataset = dataDocument?.primaryRecordDataset()
    if (dataset != null) return dataset.toLayoutStructuredSource()
    if (configuration.isEmpty()) return null
    if ("records" in configuration) {
        return runCatching {
            Json.decodeFromJsonElement<TypedRecordData>(configuration).toLayoutStructuredSource()
        }.getOrNull()
    }
    return runCatching {
        Json.decodeFromJsonElement<StructuredSourceConfig>(configuration)
    }.getOrNull()
}

private fun DataDocument.primaryRecordDataset(): DocumentDataset? =
    datasets.firstOrNull { it.kind == "records" && it.id == "records" }
        ?: datasets.firstOrNull { it.kind == "records" }
        ?: datasets.firstOrNull { it.records.isNotEmpty() }

private fun DocumentDataset.toLayoutStructuredSource(): StructuredSourceConfig {
    val selectionField = dateSelection?.field.orEmpty()
    return StructuredSourceConfig(
        dateSelection = dateSelection?.let { selection ->
            DateSelection(
                enabled = true,
                timezone = selection.timezone.ifBlank { "UTC" },
                mode = selection.mode.ifBlank { "today" },
                customStartDate = selection.customStartDate,
                customEndDate = selection.customEndDate,
                excludePast = selection.excludePast,
                noMatchBehavior = selection.noMatchBehavior.ifBlank { "empty" },
                fallbackText = selection.fallbackText,
            )
        } ?: DateSelection(),
        data = StructuredPreparedData(
            records = records.map { it.toStructuredRecord(selectionField) },
            cachedAt = cache.cachedAt,
            staleAt = cache.staleAt,
            usingCachedData = cache.usingCachedData,
            unavailable = cache.unavailable,
            fieldCurrencies = fields.mapNotNull { field -> field.currency.takeIf(String::isNotBlank)?.let { field.key to it } }.toMap(),
        ),
    )
}

private fun TypedRecordData.toLayoutStructuredSource(): StructuredSourceConfig {
    val selection = dateSelection ?: DateSelection()
    val selectionField = dateField.takeIf { selection.enabled }.orEmpty()
    return StructuredSourceConfig(
        dateSelection = selection,
        data = StructuredPreparedData(
            records = records.map { it.toStructuredRecord(selectionField) },
            cachedAt = cachedAt,
            staleAt = staleAt,
            usingCachedData = usingCachedData,
            unavailable = unavailable,
            fieldCurrencies = fields.mapNotNull { field -> field.currency.takeIf(String::isNotBlank)?.let { field.key to it } }.toMap(),
        ),
    )
}

private fun DocumentRecord.toStructuredRecord(selectionField: String): StructuredRecord {
    val converted = values.mapValues { (_, value) -> value.toDisplayString() }
    return converted.toStructuredRecord(id, selectionField)
}

private fun TypedRecord.toStructuredRecord(selectionField: String): StructuredRecord =
    values.toStructuredRecord(id, selectionField)

private fun Map<String, String>.toStructuredRecord(recordId: String, selectionField: String): StructuredRecord {
    val standardDate = get("date").orEmpty()
    val selectionDate = if (selectionField.isNotBlank()) get(selectionField).orEmpty() else ""
    return StructuredRecord(
        id = recordId,
        title = get("title").orEmpty(),
        subtitle = get("subtitle").orEmpty(),
        date = selectionDate.ifBlank { standardDate },
        author = get("author").orEmpty(),
        description = get("description").orEmpty(),
        imageUrl = get("imageUrl").orEmpty().ifBlank { get("image").orEmpty() },
        link = get("link").orEmpty(),
        values = this,
    )
}

internal fun DocumentValue.toDisplayString(): String = when (kind) {
    "number", "percent", "currency" -> number?.toString()
    "integer" -> integer?.toString()
    "boolean" -> boolean?.toString()
    "date" -> date
    "datetime" -> datetime
    "duration" -> durationSeconds?.toString()
    "url" -> url
    "asset" -> assetId
    else -> text
}.orEmpty()
