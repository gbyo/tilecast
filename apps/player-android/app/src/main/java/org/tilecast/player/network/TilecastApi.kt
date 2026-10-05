package org.tilecast.player.network

import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.Json
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import java.util.concurrent.TimeUnit
import java.io.File
import java.io.FileOutputStream
import java.security.MessageDigest

/**
 * The remaining Kotlin HTTP surface: player self-update metadata, status
 * reports, and verified artifact downloads. Core owns pairing, presence,
 * content, commands, and the socket; setup discovery stays in
 * [LanDiscovery] and identity checks go through Core.
 */
class TilecastApi(
    private val client: OkHttpClient = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS).readTimeout(15, TimeUnit.SECONDS).build(),
    private val json: Json = Json { ignoreUnknownKeys = true; encodeDefaults = true },
) {
    private val mediaType = "application/json".toMediaType()

    suspend fun playerUpdate(serverUrl:String,credential:String,releaseId:String):PlayerUpdateMetadata=get(serverUrl,"/api/v1/player/updates/$releaseId","Bearer $credential")
    suspend fun updateStatus(serverUrl:String,credential:String,deploymentId:String,state:String,downloadedBytes:Long,permissionStatus:String="",installerStatus:String="",error:String=""){
        val body=kotlinx.serialization.json.buildJsonObject{put("state",kotlinx.serialization.json.JsonPrimitive(state));put("downloadedBytes",kotlinx.serialization.json.JsonPrimitive(downloadedBytes));put("permissionStatus",kotlinx.serialization.json.JsonPrimitive(permissionStatus));put("installerStatus",kotlinx.serialization.json.JsonPrimitive(installerStatus));put("error",kotlinx.serialization.json.JsonPrimitive(error))}.toString()
        post<kotlinx.serialization.json.JsonObject>(serverUrl,"/api/v1/player/update-deployments/$deploymentId/status",body,"Bearer $credential")
    }

    suspend fun downloadVariant(serverUrl: String, path: String, credential: String, partFile: File, expectedHash: String, expectedSize: Long, progress: (Long) -> Unit) = withContext(Dispatchers.IO) {
        partFile.parentFile?.mkdirs()
        repeat(2) { attempt ->
            val offset = partFile.takeIf { it.exists() }?.length() ?: 0
            val request = Request.Builder().url(serverUrl + path).header("Authorization", "Bearer $credential").apply {
                if (offset > 0) { header("Range", "bytes=$offset-"); header("If-Range", "\"sha256-$expectedHash\"") }
            }.get().build()
            client.newCall(request).execute().use { response ->
                if (response.code == 416 && attempt == 0) { partFile.delete(); return@use }
                if (!response.isSuccessful) throw apiException(response.code, response.body?.string().orEmpty())
                val append = response.code == 206 && offset > 0
                if (!append && offset > 0) partFile.delete()
                var written = if (append) offset else 0
                FileOutputStream(partFile, append).use { output -> response.body?.byteStream()?.use { input ->
                    val buffer = ByteArray(128 * 1024)
                    while (true) { val count = input.read(buffer); if (count < 0) break; output.write(buffer, 0, count); written += count; progress(written) }
                    output.fd.sync()
                } }
                if (partFile.length() != expectedSize) throw IllegalStateException("Downloaded file size did not match the manifest")
                val digest = MessageDigest.getInstance("SHA-256"); partFile.inputStream().use { input -> val buffer=ByteArray(128*1024); while(true){val count=input.read(buffer);if(count<0)break;digest.update(buffer,0,count)} }
                val actual = digest.digest().joinToString("") { "%02x".format(it) }
                if (actual != expectedHash) { partFile.delete(); throw IllegalStateException("Downloaded file failed SHA-256 verification") }
                return@withContext
            }
        }
        throw IllegalStateException("Could not resume media download")
    }

    private fun apiException(status: Int, body: String): ApiException { val error=runCatching{json.decodeFromString(ErrorEnvelope.serializer(),body).error}.getOrNull();return ApiException(status,error?.code?:"http_$status",error?.message?:"Tilecast returned HTTP $status") }

    private suspend inline fun <reified T> get(serverUrl: String, path: String, authorization: String? = null): T = execute(
        Request.Builder().url(serverUrl + path).apply { if (authorization != null) header("Authorization", authorization) }.get().build(),
    )

    private suspend inline fun <reified T> post(serverUrl: String, path: String, body: String, authorization: String? = null): T = execute(
        Request.Builder().url(serverUrl + path).apply { if (authorization != null) header("Authorization", authorization) }.post(body.toRequestBody(mediaType)).build(),
    )

    private suspend inline fun <reified T> execute(request: Request): T = withContext(Dispatchers.IO) {
        client.newCall(request).execute().use { response ->
            val body = response.body?.string().orEmpty()
            if (!response.isSuccessful) {
                val error = runCatching { json.decodeFromString(ErrorEnvelope.serializer(), body).error }.getOrNull()
                throw ApiException(response.code, error?.code ?: "http_${response.code}", error?.message ?: "Tilecast returned HTTP ${response.code}")
            }
            json.decodeFromString(DataEnvelope.serializer(kotlinx.serialization.serializer<T>()), body).data
        }
    }
}
