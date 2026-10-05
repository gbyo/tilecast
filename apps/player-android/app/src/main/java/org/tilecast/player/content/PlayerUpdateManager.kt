package org.tilecast.player.content

import android.app.Application
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageInstaller
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.provider.Settings
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.jsonPrimitive
import org.tilecast.player.BuildConfig
import org.tilecast.player.UpdateInstallReceiver
import org.tilecast.player.network.PlayerCommand
import org.tilecast.player.network.PlayerUpdateMetadata
import org.tilecast.player.network.TilecastApi
import java.io.File
import java.security.MessageDigest
import java.time.Instant

/**
 * Least time between two download-progress reports to the server. The download
 * callback fires per chunk; without this the player would post hundreds of times
 * a second, and without any report at all Studio shows the download frozen at 0%
 * until it finishes.
 */
private const val PROGRESS_REPORT_INTERVAL_MS=2_000L

data class CommandOutcome(val success: Boolean, val code: String, val message: String)

data class UpdateUiState(val deploymentId:String,val currentVersion:String,val newVersion:String,val state:String,val downloadedBytes:Long,val expectedBytes:Long,val message:String,val permissionRequired:Boolean=false,val installReady:Boolean=false,val maintenanceAt:String?=null,val errorCode:String?=null,val releaseId:String?=null,val artifactId:String?=null,val expectedSha256:String?=null,val expectedVersionCode:Long?=null,val exactPath:String?=null)
data class ArchiveMetadata(val applicationId:String,val versionCode:Long,val certificateSha256:String,val artifactSizeBytes:Long=0,val artifactSha256:String="")

object PlayerUpdateVerifier {
    fun validate(remote:PlayerUpdateMetadata,currentVersionCode:Long,sdk:Int,archive:ArchiveMetadata,installedCertificateSha256:String){
        require(remote.applicationId==BuildConfig.APPLICATION_ID && archive.applicationId==BuildConfig.APPLICATION_ID){"package_name_mismatch"}
        require(remote.versionCode>currentVersionCode && archive.versionCode==remote.versionCode){"version_downgrade_or_mismatch"}
        require(remote.minimumSdk<=sdk){"device_incompatible"}
        require(archive.artifactSizeBytes==0L || archive.artifactSizeBytes==remote.apkSizeBytes){"artifact_size_mismatch"}
        require(archive.artifactSha256.isBlank() || archive.artifactSha256.equals(remote.apkSha256,true)){"artifact_hash_mismatch"}
        require(archive.certificateSha256.equals(remote.signingCertificateSha256,true)){"certificate_mismatch"}
        require(archive.certificateSha256.equals(installedCertificateSha256,true)){"installed_certificate_mismatch"}
    }
}

object PlayerUpdateInstallPolicy {
    fun canRequestUnattended(sdk:Int):Boolean=sdk>=Build.VERSION_CODES.S
}

internal fun stagedArtifactName(releaseId:String,artifactId:String):String {
    val release = releaseId.replace(Regex("[^A-Za-z0-9._-]"), "_")
    val artifact = artifactId.ifBlank { "artifact" }.replace(Regex("[^A-Za-z0-9._-]"), "_")
    return "$release-$artifact.apk"
}

/** Select only the server-requested artifact; directory order and mtime are irrelevant. */
internal fun selectExactStagedArtifact(directory:File,releaseId:String,artifactId:String):File? =
    File(directory,stagedArtifactName(releaseId,artifactId)).takeIf { it.isFile }

class PlayerUpdateManager(private val app:Application,private val api:TilecastApi){
    private val store=app.getSharedPreferences("tilecast-player-updates",Application.MODE_PRIVATE)
    private val scope=CoroutineScope(SupervisorJob()+Dispatchers.Default)
    private var maintenanceJob:Job?=null
    private val listeners=java.util.concurrent.CopyOnWriteArrayList<(UpdateUiState)->Unit>()
    /** Observes every persisted update state. The production ViewModel shows the approval UI from this. */
    fun addListener(listener:(UpdateUiState)->Unit){listeners+=listener}
    fun removeListener(listener:(UpdateUiState)->Unit){listeners-=listener}
    val restored:UpdateUiState? get()=store.getString("deployment",null)?.let{deployment->val next=store.getString("new-version","")?:"";if(next==BuildConfig.VERSION_NAME){store.edit().clear().apply();null}else UpdateUiState(deployment,BuildConfig.VERSION_NAME,next,store.getString("state","pending")?:"pending",store.getLong("downloaded",0),store.getLong("expected",0),"Player update is ready to continue",store.getBoolean("permission",false),store.getBoolean("ready",false),store.getString("maintenance-at",null),store.getString("error-code",null),store.getString("release-id",null),store.getString("artifact-id",null),store.getString("expected-sha256",null),store.getLong("expected-version-code",0).takeIf{it>0},store.getString("exact-path",null))}

    private fun updateDirectory():File = File(app.filesDir,"updates").apply { mkdirs() }

    private fun quarantineStaleArtifacts(exactPath:String?) {
        val directory = updateDirectory()
        val exact = exactPath?.let(::File)?.canonicalPath
        val quarantine = File(directory,"quarantine").apply { mkdirs() }
        directory.listFiles()?.filter { it.isFile && it.extension == "apk" && it.canonicalPath != exact }?.forEach { file ->
            val target = File(quarantine,"${file.name}.${System.currentTimeMillis()}.stale")
            runCatching { file.renameTo(target) }
        }
    }

    suspend fun prepare(server:String,credential:String,command:PlayerCommand,takeoverActive:()->Boolean,onState:(UpdateUiState)->Unit):CommandOutcome{
        val deployment=command.payload["deploymentId"]?.jsonPrimitive?.contentOrNull?:return CommandOutcome(false,"update_payload_invalid","Update deployment is invalid")
        val release=command.payload["releaseId"]?.jsonPrimitive?.contentOrNull?:return CommandOutcome(false,"update_payload_invalid","Update release is invalid")
        val expected=command.payload["expectedVersionCode"]?.jsonPrimitive?.longOrNull?:return CommandOutcome(false,"update_payload_invalid","Expected version is invalid")
        if(expected<=BuildConfig.VERSION_CODE)return CommandOutcome(true,"update_already_current","Player is already current")
        var progressReporter:SerializedUpdateStatusReporter?=null
        return try{
            val metadata=api.playerUpdate(server,credential,release)
            val stem=stagedArtifactName(metadata.releaseId,metadata.artifactId).removeSuffix(".apk")
            val part=File(updateDirectory(),"$stem.apk.part")
            val exactPath=File(updateDirectory(),"$stem.apk").absolutePath
            quarantineStaleArtifacts(exactPath)
            var state=UpdateUiState(deployment,BuildConfig.VERSION_NAME,metadata.versionName,"downloading",part.takeIf{it.exists()}?.length()?:0,metadata.apkSizeBytes,"Downloading player update",releaseId=metadata.releaseId,artifactId=metadata.artifactId,expectedSha256=metadata.apkSha256,expectedVersionCode=metadata.versionCode,exactPath=exactPath)
            persist(state);onState(state);api.updateStatus(server,credential,deployment,"downloading",state.downloadedBytes)
            // Progress goes to the server as well as the local screen: the
            // deployment drawer has no other source for a download percentage,
            // and reporting it per chunk would be a request per few kilobytes.
            val reporter=SerializedUpdateStatusReporter(scope,PROGRESS_REPORT_INTERVAL_MS){written->api.updateStatus(server,credential,deployment,"downloading",written)}
            progressReporter=reporter
            api.downloadVariant(server,metadata.apkPath,credential,part,metadata.apkSha256,metadata.apkSizeBytes){written->
                state=state.copy(downloadedBytes=written);persist(state);onState(state);reporter.submit(written)
            }
            reporter.awaitIdle()
            state=state.copy(state="verifying",downloadedBytes=metadata.apkSizeBytes,message="Verifying signed player update");persist(state);onState(state);api.updateStatus(server,credential,deployment,"verifying",state.downloadedBytes)
            val archive=inspect(part,metadata.apkSha256,metadata.apkSizeBytes)
            PlayerUpdateVerifier.validate(metadata,BuildConfig.VERSION_CODE.toLong(),Build.VERSION.SDK_INT,archive,installedCertificateSha256())
            val final=File(exactPath);if(final.exists())final.delete();if(!part.renameTo(final))throw IllegalStateException("update_file_finalize_failed")
            state=state.copy(exactPath=final.absolutePath)
            if(command.payload["installationMode"]?.jsonPrimitive?.contentOrNull=="download_only"){
                state=state.copy(state="ready",message="Update downloaded and verified");persist(state);onState(state);api.updateStatus(server,credential,deployment,"ready",state.downloadedBytes);return CommandOutcome(true,"update_downloaded","Player update downloaded and verified")
            }
            val maintenanceAt=command.payload["maintenanceWindowStart"]?.jsonPrimitive?.contentOrNull?.takeIf{it!="null"}
            if(command.payload["installationMode"]?.jsonPrimitive?.contentOrNull=="maintenance_window"&&maintenanceAt!=null&&Instant.parse(maintenanceAt).isAfter(Instant.now())){state=state.copy(state="ready",message="Installation scheduled for ${maintenanceAt}",maintenanceAt=maintenanceAt);persist(state);onState(state);api.updateStatus(server,credential,deployment,"ready",state.downloadedBytes,installerStatus="maintenance_scheduled");scheduleMaintenance(server,credential,state,takeoverActive,onState);return CommandOutcome(true,"update_maintenance_scheduled","Update verified for its maintenance window")}
            if(takeoverActive()){state=state.copy(state="ready",message="Installation delayed by takeover playback",installReady=true,maintenanceAt=Instant.now().toString());persist(state);onState(state);api.updateStatus(server,credential,deployment,"ready",state.downloadedBytes,installerStatus="delayed_by_takeover");scheduleMaintenance(server,credential,state,takeoverActive,onState);return CommandOutcome(true,"update_ready_takeover_delay","Update verified; installation is delayed by takeover playback")}
            if(Build.VERSION.SDK_INT>=26&&!app.packageManager.canRequestPackageInstalls()){
                state=state.copy(state="waiting_for_permission",message="Allow Tilecast Player to install updates",permissionRequired=true,installReady=true);persist(state);onState(state);api.updateStatus(server,credential,deployment,"waiting_for_permission",state.downloadedBytes,"required");return CommandOutcome(true,"update_waiting_for_permission","Update is waiting for unknown-app permission")
            }
            if(PlayerUpdateInstallPolicy.canRequestUnattended(Build.VERSION.SDK_INT)){
                state=state.copy(state="installing",message="Installing verified player update",installReady=false);persist(state);onState(state)
                if(!install(state))throw IllegalStateException("installer_session_failed")
                api.updateStatus(server,credential,deployment,"installing",state.downloadedBytes,permissionStatus="granted",installerStatus="unattended_install_requested")
                return CommandOutcome(true,"unattended_update_started","Verified Player update installation started")
            }
            state=state.copy(state="waiting_for_user",message="This Android version requires local installer approval",installReady=true);persist(state);onState(state);api.updateStatus(server,credential,deployment,"waiting_for_user",state.downloadedBytes,permissionStatus="granted",installerStatus="system_confirmation_required");CommandOutcome(true,"update_waiting_for_user","This Android version requires local installer approval")
        }catch(error:Exception){progressReporter?.awaitIdle();val code=error.message?.takeIf{it.matches(Regex("[a-z_]+"))}?:"update_preparation_failed";api.updateStatus(server,credential,deployment,"failed",0,error=code);CommandOutcome(false,code,"Player update could not be prepared")}
    }

    fun openPermissionSettings(){app.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:${app.packageName}")).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK))}
    /** Folds installer results and permission grants into the persisted state and reports the outcome. */
    suspend fun refreshPermission(server:String?,credential:String?,state:UpdateUiState):UpdateUiState{
        val changed=installerFailure(state)?:permissionGranted(state)?:return state
        if(server!=null&&credential!=null)runCatching{api.updateStatus(server,credential,changed.deploymentId,changed.state,changed.downloadedBytes,if(changed.permissionRequired)"required" else "granted",error=if(changed.state=="failed")changed.errorCode?:"installer_failed" else "")}
        return changed
    }
    /** Starts the system installer for a ready update and reports the handoff. Null when the installer refused to start. */
    suspend fun beginInstall(server:String?,credential:String?,state:UpdateUiState):UpdateUiState?{
        if(!install(state))return null
        val installing=state.copy(state="installing",message="Complete installation in the Android prompt")
        persist(installing)
        if(server!=null&&credential!=null)runCatching{api.updateStatus(server,credential,state.deploymentId,"installing",state.downloadedBytes,"granted","system_installer_started")}
        return installing
    }
    fun permissionGranted(state:UpdateUiState):UpdateUiState? {
        if((Build.VERSION.SDK_INT>=26&&!app.packageManager.canRequestPackageInstalls())||!state.permissionRequired)return null
        val next=if(PlayerUpdateInstallPolicy.canRequestUnattended(Build.VERSION.SDK_INT))state.copy(state="installing",message="Installing verified player update",permissionRequired=false,installReady=false) else state.copy(state="waiting_for_user",message="This Android version requires local installer approval",permissionRequired=false,installReady=true)
        persist(next)
        return if(next.state=="installing"&&!install(next))next.copy(state="failed",message="Android could not start the installer",errorCode="installer_session_failed").also(::persist) else next
    }
    fun installerFailure(state:UpdateUiState):UpdateUiState?{val result=store.getString("installer-result",null)?:return null;store.edit().remove("installer-result").apply();return when(result){"success"->null;"installer_confirmation_required"->state.copy(state="waiting_for_user",message="Android requires local installer approval on this device",permissionRequired=false,installReady=true,errorCode=null).also(::persist);else->state.copy(state="failed",message="Android did not install the update: ${result.replace('_',' ')}",permissionRequired=false,installReady=true,errorCode=result).also(::persist)}}
    fun resumeMaintenance(server:String,credential:String,state:UpdateUiState,takeoverActive:()->Boolean,onState:(UpdateUiState)->Unit){if(state.state=="ready"&&state.maintenanceAt!=null)scheduleMaintenance(server,credential,state,takeoverActive,onState)}
    private fun scheduleMaintenance(server:String,credential:String,state:UpdateUiState,takeoverActive:()->Boolean,onState:(UpdateUiState)->Unit){if(maintenanceJob?.isActive==true)return;maintenanceJob=scope.launch{delay(java.time.Duration.between(Instant.now(),Instant.parse(state.maintenanceAt)).toMillis().coerceAtLeast(0));while(takeoverActive()){delay(30_000)};val permissionRequired=Build.VERSION.SDK_INT>=26&&!app.packageManager.canRequestPackageInstalls();val unattended=!permissionRequired&&PlayerUpdateInstallPolicy.canRequestUnattended(Build.VERSION.SDK_INT);var next=state.copy(state=if(permissionRequired)"waiting_for_permission" else if(unattended)"installing" else "waiting_for_user",message=if(permissionRequired)"Allow Tilecast Player to install updates" else if(unattended)"Installing verified player update" else "This Android version requires local installer approval",permissionRequired=permissionRequired,installReady=!permissionRequired&&!unattended);persist(next);onState(next);if(unattended&&!install(next)){next=next.copy(state="failed",message="Android could not start the installer",errorCode="installer_session_failed");persist(next);onState(next)};runCatching{api.updateStatus(server,credential,next.deploymentId,next.state,next.downloadedBytes,if(permissionRequired)"required" else "granted",installerStatus=if(unattended)"unattended_install_requested" else "maintenance_window_reached",error=next.errorCode?:"")}}}
    fun install(state:UpdateUiState):Boolean{
        val persisted=state.exactPath?.let(::File)?:return false
        val apk=if(!state.releaseId.isNullOrBlank()&&!state.artifactId.isNullOrBlank()){
            val selected=selectExactStagedArtifact(updateDirectory(),state.releaseId,state.artifactId)?:return false
            if(selected.canonicalPath!=persisted.canonicalPath)return false
            selected
        } else persisted
        if(!apk.isFile || state.expectedSha256.isNullOrBlank() || state.expectedBytes<=0 || state.expectedVersionCode==null)return false
        quarantineStaleArtifacts(apk.absolutePath)
        if(!verifyArtifact(apk,state.expectedSha256,state.expectedBytes))return false
        val reliability=app.getSharedPreferences("tilecast-reliability",Application.MODE_PRIVATE)
        val started=runCatching{
            val params=PackageInstaller.SessionParams(PackageInstaller.SessionParams.MODE_FULL_INSTALL).apply{setAppPackageName(BuildConfig.APPLICATION_ID);setSize(apk.length());if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.S)setRequireUserAction(PackageInstaller.SessionParams.USER_ACTION_NOT_REQUIRED)}
            val installer=app.packageManager.packageInstaller
            val sessionId=installer.createSession(params)
            reliability.edit().putBoolean("update-active",true).putBoolean("update-relaunch-requested",true).putInt("update-relaunch-attempts",0).apply()
            installer.openSession(sessionId).use{session->apk.inputStream().use{input->session.openWrite("tilecast-player.apk",0,apk.length()).use{output->input.copyTo(output);session.fsync(output)}};val intent=Intent(app,UpdateInstallReceiver::class.java);val pending=PendingIntent.getBroadcast(app,sessionId,intent,PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_MUTABLE);session.commit(pending.intentSender)}
            persist(state.copy(state="installing",message="Android installer is preparing the update"));true
        }.getOrDefault(false)
        if(!started)reliability.edit().putBoolean("update-active",false).putBoolean("update-relaunch-requested",false).apply()
        return started
    }

    private fun verifyArtifact(file:File,expectedSha256:String,expectedSize:Long):Boolean {
        if(!file.isFile || file.length()!=expectedSize)return false
        val digest=MessageDigest.getInstance("SHA-256")
        file.inputStream().use { input ->
            val buffer=ByteArray(64*1024)
            while(true){val count=input.read(buffer);if(count<0)break;digest.update(buffer,0,count)}
        }
        return digest.digest().joinToString(""){ "%02x".format(it) }.equals(expectedSha256,true)
    }

    @Suppress("DEPRECATION") private fun inspect(file:File,expectedSha256:String="",expectedSize:Long=0):ArchiveMetadata{
        require(expectedSize<=0 || file.length()==expectedSize){"artifact_size_mismatch"}
        val artifactSha=if(expectedSha256.isBlank())"" else run { require(verifyArtifact(file,expectedSha256,expectedSize)){"artifact_hash_mismatch"};expectedSha256.lowercase() }
        val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info=app.packageManager.getPackageArchiveInfo(file.absolutePath,flags)?:throw IllegalStateException("package_metadata_invalid")
        val version=if(Build.VERSION.SDK_INT>=28)info.longVersionCode else info.versionCode.toLong()
        val signatures=if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners else info.signatures
        val certificate=signatures?.firstOrNull()?.toByteArray()?:throw IllegalStateException("certificate_missing")
        return ArchiveMetadata(info.packageName,version,MessageDigest.getInstance("SHA-256").digest(certificate).joinToString(""){"%02x".format(it)},file.length(),artifactSha)
    }
    @Suppress("DEPRECATION") private fun installedCertificateSha256():String{
        val flags=if(Build.VERSION.SDK_INT>=28)PackageManager.GET_SIGNING_CERTIFICATES else PackageManager.GET_SIGNATURES
        val info=app.packageManager.getPackageInfo(BuildConfig.APPLICATION_ID,flags)
        val signatures=if(Build.VERSION.SDK_INT>=28)info.signingInfo?.apkContentsSigners else info.signatures
        val certificate=signatures?.firstOrNull()?.toByteArray()?:throw IllegalStateException("installed_certificate_missing")
        return MessageDigest.getInstance("SHA-256").digest(certificate).joinToString(""){"%02x".format(it)}
    }
    private fun persist(state:UpdateUiState){store.edit().putString("deployment",state.deploymentId).putString("new-version",state.newVersion).putString("state",state.state).putLong("downloaded",state.downloadedBytes).putLong("expected",state.expectedBytes).putBoolean("permission",state.permissionRequired).putBoolean("ready",state.installReady).apply{if(state.maintenanceAt==null)remove("maintenance-at") else putString("maintenance-at",state.maintenanceAt);if(state.errorCode==null)remove("error-code") else putString("error-code",state.errorCode);if(state.releaseId==null)remove("release-id") else putString("release-id",state.releaseId);if(state.artifactId==null)remove("artifact-id") else putString("artifact-id",state.artifactId);if(state.expectedSha256==null)remove("expected-sha256") else putString("expected-sha256",state.expectedSha256);if(state.expectedVersionCode==null)remove("expected-version-code") else putLong("expected-version-code",state.expectedVersionCode);if(state.exactPath==null)remove("exact-path") else putString("exact-path",state.exactPath)}.apply();listeners.forEach{runCatching{it(state)}}}
}
