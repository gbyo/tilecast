package org.tilecast.player.network

import kotlinx.serialization.Serializable
import kotlinx.serialization.SerialName

@Serializable data class DataEnvelope<T>(val data: T)
@Serializable data class ErrorEnvelope(val error: ApiErrorBody? = null)
@Serializable data class ApiErrorBody(val code: String = "unknown_error", val message: String = "Tilecast could not complete the request")
@Serializable data class ServerIdentity(val product: String, val installationId: String, val organizationName: String, val apiVersion: String, val pairingEnabled: Boolean)
object PlayerPresentationSupport {
    val schemas = listOf(1)
    val native = PresentationCapabilities.BASELINE_DECLARATIVE_PRESENTATION_CAPABILITIES
    const val webRuntimeVersion = 2
    const val webBundleLimitBytes = 20L * 1024 * 1024
}

@Serializable data class ManifestBranding(val logoAssetId:String?=null,val logoVariantId:String?=null)
@Serializable data class PlayerManifest(val schemaVersion: Int, val manifestVersion: Long, val screenId: String, val generatedAt: String, val mode: String, val playlist: ManifestPlaylist? = null, val directFallbackPlaylist:ManifestPlaylist?=null,val playlists:List<ManifestPlaylist> = emptyList(),val layout:ManifestLayout?=null,val directFallbackLayout:ManifestLayout?=null,val layouts:List<ManifestLayout> = emptyList(),val schedules:List<ManifestSchedule> = emptyList(),val assets: List<ManifestAsset> = emptyList(),val branding:ManifestBranding?=null,val websites:List<ManifestWebsite> = emptyList(),val widgets:List<ManifestWidget> = emptyList(),val dataSources:List<ManifestDataSource> = emptyList(),val presentationOverride:ManifestPresentationOverride?=null,val takeover:ManifestTakeover?=null,val emergency:ManifestTakeover?=null,val plugins:List<ManifestPlugin> = emptyList(),val syncGroup:ManifestSyncGroup?=null,val canvas:ManifestCanvas?=null,val viewport:ManifestViewport?=null,val serverTime:String?=null,val prefetchHorizonDays:Int=14,val activationGraceSeconds:Int=30) {
    val effectiveTakeover: ManifestTakeover? get() = takeover ?: emergency
}
@Serializable data class ManifestPlugin(val id:String,val type:String,val version:Int,val config:ManifestPluginConfig)
/**
 * The plugin channel carries one array for every built-in plugin, so one config
 * shape covers all of them and every field a given plugin does not use keeps its
 * default. `type` and `version` say which fields are meaningful; a resolver that
 * reads a field belonging to another plugin is the bug this makes visible rather
 * than one polymorphic serializer per bar would.
 */
@Serializable data class ManifestPluginConfig(val name:String="",val message:String="",val scheduleType:String="",val targetTime:String?=null,val daysOfWeek:List<Int> = emptyList(),val oneTimeAt:String?=null,val timezone:String="UTC",val leadTimeSeconds:Int=0,val completionText:String="",val showConfetti:Boolean=false,val displayMode:String="overlay",val heightPx:Int=72,val progressFill:String="none",val contentPadding:Int=4,val textScale:Int=100,val urgencyEnabled:Boolean=false,val startingSoonSeconds:Int=300,val urgentSeconds:Int=60,val pulseSeconds:Int=10,val priority:Int=0,val severity:String="",val event:String="",val speed:String="medium",val expiresAt:String="")
@Serializable data class ManifestSyncGroup(val id:String,val playbackEpoch:String)
@Serializable data class ManifestCanvas(val width:Int,val height:Int)
@Serializable data class ManifestViewport(val x:Int,val y:Int,val width:Int,val height:Int,val rotation:Int=0,val order:Int=0,val bezelLeft:Int=0,val bezelTop:Int=0,val bezelRight:Int=0,val bezelBottom:Int=0)
@Serializable data class ManifestTakeover(val id:String,val playlistId:String,val activatedAt:String,val expiresAt:String)
@Serializable data class ManifestPresentationOverride(val id:String,val contentType:String,val contentId:String,val contentName:String,val startedAt:String,val expiresAt:String?=null,val playlistId:String?=null,val layoutId:String?=null,val wakeDisplay:Boolean=false)
@Serializable data class ManifestPlaylist(val id: String, val revision: Long, val name: String, val items: List<ManifestItem>)
@Serializable data class ManifestLayout(val id:String,val revisionId:String,val revision:Long,val documentSha256:String,val document:LayoutDocument)
@Serializable data class ManifestDisplayControlAction(val type:String,val input:String?=null,val volume:Int?=null,val brightness:Int?=null)
@Serializable data class ManifestSchedule(val id:String,val playlistId:String?=null,val type:String,val timezone:String,val priority:Int,val specificity:Int,val layoutId:String?=null,val displayAction:ManifestDisplayControlAction?=null,val startDate:String?=null,val endDate:String?=null,val oneTimeStart:String?=null,val oneTimeEnd:String?=null,val dailyStart:String?=null,val dailyEnd:String?=null,val daysOfWeek:List<Int> = emptyList())
@Serializable data class ManifestItem(val id: String, val assetId: String, val variantId: String?=null,val assetType:String="", val durationMs: Long? = null, val fitMode: String, val transition: String, val audioEnabled: Boolean, val volume: Float, val videoStartOffsetMs: Long? = null, val videoEndOffsetMs: Long? = null, val deliveryPolicy: String,val layoutId:String?=null,val availableFrom:String?=null,val expiresAt:String?=null,val usePlayerDefaults:Boolean=false)
@Serializable data class ManifestWebsite(val assetId:String,val name:String,val url:String,val allowedHosts:List<String>,val javascriptEnabled:Boolean,val domStorageEnabled:Boolean,val cookiePolicy:String,val reloadPolicy:String,val refreshIntervalSeconds:Int?=null,val loadTimeoutSeconds:Int,val zoomPercent:Int,val scrollX:Int,val scrollY:Int,val customUserAgent:String="",val backgroundColor:String="#0E141B",val failureBehavior:String,val fallbackImageAssetId:String?=null,val fallbackVariantId:String?=null)
@Serializable data class ManifestWidget(val assetId:String,val name:String,val provider:String="",val configVersion:Int=0,val configuration:kotlinx.serialization.json.JsonObject=kotlinx.serialization.json.buildJsonObject{},val presentation:WidgetPresentation?=null)
@Serializable data class ManifestDataSource(val id:String,val name:String,val provider:String="",val configVersion:Int=0,val configuration:kotlinx.serialization.json.JsonObject=kotlinx.serialization.json.buildJsonObject{},val dataDocument:DataDocument?=null)
@Serializable data class DataDocument(val schemaVersion:Int,val datasets:List<DocumentDataset> = emptyList())
@Serializable data class DocumentDataset(val id:String,val kind:String,val fields:List<DocumentField> = emptyList(),val scalar:DocumentValue?=null,val records:List<DocumentRecord> = emptyList(),val points:List<DocumentPoint> = emptyList(),val value:DocumentValue?=null,val cache:DocumentCacheState=DocumentCacheState(),val attribution:String="",val timezone:String="",val dateSelection:DocumentDateSelection?=null,val units:Map<String,String> = emptyMap())
@Serializable data class DocumentField(val key:String,val label:String,val type:String,val unit:String="",val currency:String="")
@Serializable data class DocumentRecord(val id:String,val values:Map<String,DocumentValue> = emptyMap())
@Serializable data class DocumentPoint(val at:String,val value:DocumentValue?=null,val values:Map<String,DocumentValue> = emptyMap())
@Serializable data class DocumentValue(val kind:String,val text:String?=null,val number:Double?=null,val integer:Long?=null,val boolean:Boolean?=null,val date:String?=null,val datetime:String?=null,val durationSeconds:Long?=null,val url:String?=null,val assetId:String?=null,val list:List<DocumentValue> = emptyList(),@SerialName("object") val objectValue:Map<String,DocumentValue> = emptyMap())
@Serializable data class DocumentCacheState(val cachedAt:String?=null,val staleAt:String?=null,val usingCachedData:Boolean=false,val unavailable:Boolean=false,val lastModified:String="",val upstreamExpiry:String?=null)
@Serializable data class DocumentDateSelection(val field:String,val timezone:String,val mode:String,val customStartDate:String="",val customEndDate:String="",val excludePast:Boolean=false,val noMatchBehavior:String="",val fallbackText:String="")
@Serializable data class WidgetPresentation(val schemaVersion:Int,val kind:String,val requiredCapabilities:Map<String,Int> = emptyMap(),val native:NativePresentation?=null,val web:WebSandboxPresentation?=null,val component:ComponentPresentation?=null)
@Serializable data class ComponentPresentation(val type:String,val version:Int,val config:kotlinx.serialization.json.JsonObject=kotlinx.serialization.json.buildJsonObject{},val dataSources:List<String> = emptyList(),val media:List<ComponentMediaRef> = emptyList())
@Serializable data class ComponentMediaRef(val assetId:String,val variantId:String)
@Serializable data class NativePresentation(val root:PresentationNode)
@Serializable data class PresentationNode(val id:String="",val type:String,val props:kotlinx.serialization.json.JsonObject=kotlinx.serialization.json.buildJsonObject{},val binding:PresentationBinding?=null,val repeat:PresentationRepeat?=null,val condition:PresentationCondition?=null,val children:List<PresentationNode> = emptyList())
@Serializable data class PresentationBinding(val source:String,val dataset:String="",val path:String="",val selector:String="all",val startField:String="",val endField:String="",val value:String="",val fields:List<String> = emptyList(),val format:String="",val precision:Int?=null,val prefix:String="",val suffix:String="",val fallback:String="",val separator:String="")
@Serializable data class PresentationRepeat(val dataset:String,val limit:Int,val offset:Int=0,val selector:String="all",val startField:String="",val endField:String="")
@Serializable data class PresentationCondition(val binding:PresentationBinding,val op:String,val value:String="")
@Serializable data class WebReload(val mode:String,val intervalSeconds:Int)
@Serializable data class WebSandboxPresentation(val mode:String,val url:String="",val bundleId:String="",val entryPoint:String="",val integritySha256:String="",val packageSize:Long=0,val downloadPath:String="",val allowedHosts:List<String> = emptyList(),val externalNetworkAccess:Boolean=false,val onlineOnly:Boolean=false,val fallbackBehavior:String="placeholder",val loadTimeoutSeconds:Int=20,val lifecycle:String="destroy_on_hide",val warmSeconds:Int=0,val reload:WebReload?=null)
@Serializable data class WebsiteSourceConfig(val url:String,val displayUrl:String="",val allowedHosts:List<String>,val javascriptEnabled:Boolean=true,val domStorageEnabled:Boolean=true,val cookiePolicy:String="first_party",val reloadPolicy:String="on_each_activation",val refreshIntervalSeconds:Int?=null,val loadTimeoutSeconds:Int=20,val zoomPercent:Int=100,val scrollX:Int=0,val scrollY:Int=0,val customUserAgent:String="",val backgroundColor:String="#0E141B",val failureBehavior:String="placeholder",val fallbackImageAssetId:String?=null,val fallbackVariantId:String?=null)
@Serializable data class ManifestAsset(val assetId: String, val variantId: String, val mimeType: String, val sha256: String, val fileSize: Long, val width: Int? = null, val height: Int? = null, val durationSeconds: Double? = null, val downloadPath: String, val availableFrom: String? = null, val expiresAt: String? = null)
@Serializable data class PlayerBranding(val organizationName:String="Tilecast",val logoAssetId:String?=null,val backgroundColor:String="#0E141B",val textColor:String="#F5F7FA",val noContentTitle:String="No content assigned",val noContentMessage:String="This screen is ready for content.",val disabledTitle:String="Playback disabled",val disabledMessage:String="This screen remains connected to Tilecast Studio.",val footerText:String="")
@Serializable data class RegionalFormatting(val locale:String,val timezone:String,val dateFormat:String,val timeFormat:String,val firstDayOfWeek:String)
@Serializable data class PlayerPlaybackDefaults(val defaultVolume:Double=.5,val defaultFitMode:String="contain",val defaultImageDurationSeconds:Int=10,val defaultTransition:String="none",val defaultAudioEnabled:Boolean=true,val resumeAfterRestart:Boolean=true,val identifyShowsLocation:Boolean=true,val screenLocation:String="",val regionalFormat:RegionalFormatting?=null)
@Serializable data class PlayerWebsitePolicy(val timeoutSeconds:Int=20,val cookiePolicy:String="first_party",val clearOnRestart:Boolean=false,val defaultJavascript:Boolean=true,val defaultDomStorage:Boolean=true,val defaultTimeoutSeconds:Int=20,val defaultCookiePolicy:String="first_party",val defaultReloadPolicy:String="on_each_activation",val minimumRefreshSeconds:Int=30,val defaultFailureBehavior:String="placeholder",val defaultZoomPercent:Int=100,val defaultFallbackImageId:String="")
@Serializable data class PlayerCommand(val id:String,val type:String,val payload:kotlinx.serialization.json.JsonObject = kotlinx.serialization.json.buildJsonObject{},val idempotencyKey:String,val state:String,val createdAt:String,val expiresAt:String)
@Serializable data class PlayerUpdateMetadata(val releaseId:String,val applicationId:String,val versionCode:Long,val versionName:String,val minimumSdk:Int,val apkSizeBytes:Long,val apkSha256:String,val signingCertificateSha256:String,val apkPath:String,val artifactId:String="")


class ApiException(val status: Int, val code: String, override val message: String) : Exception(message)