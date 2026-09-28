package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.int
import kotlinx.serialization.json.jsonArray
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import java.security.MessageDigest

/** Verifies a packaged shared-runtime directory against its `runtime-manifest.json`.
 *
 * Mirrors the Electron/WPE assembly checks: every packaged file must be listed
 * in the manifest with matching SHA-256 and size; missing files, extra files,
 * malformed entries, path traversal and duplicate normalized paths are refused.
 * The APK must package the generated `packages/player-runtime/dist/runtime`
 * artifact, never a hand-copied snapshot.
 */
object RuntimeManifestVerifier {

    data class ManifestEntry(val path: String, val bytes: Long, val sha256: String)

    data class FileBytes(val relativePath: String, val bytes: ByteArray)

    sealed interface Result {
        data object Ok : Result
        data class Refused(val reason: String) : Result
    }

    private val json = Json { ignoreUnknownKeys = false }

    fun parseManifest(raw: String): kotlin.Result<List<ManifestEntry>> = runCatching {
        val root = json.parseToJsonElement(raw).jsonObject
        root["files"]!!.jsonArray.map { element ->
            val obj = element.jsonObject
            ManifestEntry(
                path = obj["path"]!!.jsonPrimitive.content,
                bytes = obj["bytes"]!!.jsonPrimitive.content.toLong(),
                sha256 = obj["sha256"]!!.jsonPrimitive.content.lowercase(),
            )
        }
    }

    fun verify(manifestRaw: String, packaged: List<FileBytes>): Result {
        val entries = parseManifest(manifestRaw).getOrElse {
            return Result.Refused("malformed manifest: ${it.message}")
        }
        if (entries.isEmpty()) return Result.Refused("malformed manifest: no files listed")

        val seen = HashSet<String>()
        for (entry in entries) {
            val normalized = normalize(entry.path)
                ?: return Result.Refused("malformed manifest entry: ${entry.path}")
            if (!seen.add(normalized)) {
                return Result.Refused("duplicate manifest path: ${entry.path}")
            }
            if (entry.bytes < 0) return Result.Refused("malformed manifest entry: ${entry.path}")
            if (!entry.sha256.matches(Regex("[0-9a-f]{64}"))) {
                return Result.Refused("malformed manifest entry: ${entry.path}")
            }
        }

        val packagedByPath = HashMap<String, ByteArray>()
        for (file in packaged) {
            if (file.relativePath == "runtime-manifest.json") continue
            val normalized = normalize(file.relativePath)
                ?: return Result.Refused("refused packaged path: ${file.relativePath}")
            if (packagedByPath.put(normalized, file.bytes) != null) {
                return Result.Refused("duplicate packaged path: ${file.relativePath}")
            }
        }

        for (entry in entries) {
            val normalized = normalize(entry.path)!!
            val bytes = packagedByPath.remove(normalized)
                ?: return Result.Refused("missing runtime file: ${entry.path}")
            if (bytes.size.toLong() != entry.bytes) {
                return Result.Refused("size mismatch: ${entry.path}")
            }
            if (sha256Hex(bytes) != entry.sha256) {
                return Result.Refused("hash mismatch: ${entry.path}")
            }
        }
        if (packagedByPath.isNotEmpty()) {
            return Result.Refused("unexpected runtime file: ${packagedByPath.keys.sorted().first()}")
        }
        return Result.Ok
    }

    /** Normalized `top-level` or `fonts/<name>` paths only; null when refused. */
    internal fun normalize(path: String): String? {
        if (path.isEmpty() || path.length > 256) return null
        if (path.startsWith("/") || path.contains("\\") || path.contains("\u0000")) return null
        val segments = path.split("/")
        if (segments.any { it.isEmpty() || it == "." || it == ".." }) return null
        if (segments.size > 2) return null
        if (segments.size == 2 && segments[0] != "fonts") return null
        val last = segments.last()
        if (last.length > 128 || last.startsWith(".")) return null
        if (!last.matches(Regex("[A-Za-z0-9._-]+"))) return null
        return path
    }

    private fun sha256Hex(bytes: ByteArray): String {
        val digest = MessageDigest.getInstance("SHA-256").digest(bytes)
        return digest.joinToString("") { "%02x".format(it) }
    }
}
