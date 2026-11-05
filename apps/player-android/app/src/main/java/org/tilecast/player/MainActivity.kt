package org.tilecast.player

import android.annotation.SuppressLint
import android.os.Bundle
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Handler
import android.os.Looper
import android.view.KeyEvent
import android.provider.Settings
import android.net.Uri
import android.webkit.WebView
import androidx.activity.ComponentActivity
import androidx.activity.compose.setContent
import androidx.activity.enableEdgeToEdge
import androidx.activity.viewModels
import androidx.activity.compose.LocalActivity
import androidx.compose.ui.viewinterop.AndroidView
import androidx.core.view.WindowCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.content.ContextCompat
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.text.input.KeyboardType
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.lifecycle.lifecycleScope
import androidx.lifecycle.viewmodel.compose.viewModel
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.tilecast.player.content.UpdateUiState
import org.tilecast.player.core.PlayerState
import org.tilecast.player.core.ProcessRenderer
import org.tilecast.player.core.RendererLifecycle
import org.tilecast.player.core.RendererPhase
import org.tilecast.player.core.RendererPresentation
import org.tilecast.player.core.WebViewCoreRenderer
import org.tilecast.player.preview.PlayerWindowCapture
import org.tilecast.player.preview.WindowCapture
import org.tilecast.player.preview.encodeCaptureFrame
import org.tilecast.player.reliability.ReliabilityController
import org.tilecast.player.reliability.isMaintenanceSettingsLaunchAllowed
import org.tilecast.player.reliability.permittedMaintenanceSettings
import org.tilecast.player.ui.theme.SignalBackground
import org.tilecast.player.ui.theme.SignalBlue
import org.tilecast.player.ui.theme.SignalDanger
import org.tilecast.player.ui.theme.SignalDimensions
import org.tilecast.player.ui.theme.SignalMuted
import org.tilecast.player.ui.theme.SignalOutlinedButton
import org.tilecast.player.ui.theme.SignalText
import org.tilecast.player.ui.theme.SignalWarning
import org.tilecast.player.ui.theme.SignalButton
import org.tilecast.player.ui.theme.TilecastSignalTheme
import org.tilecast.player.ui.CenteredMessage
import org.tilecast.player.ui.IdentityMismatchScreen
import org.tilecast.player.ui.LoadingScreen
import org.tilecast.player.ui.ManualEntryScreen
import org.tilecast.player.ui.PairingScreen
import org.tilecast.player.ui.RevokedScreen
import org.tilecast.player.ui.SearchingScreen
import org.tilecast.player.ui.WithPhoneSetup
import org.tilecast.player.ui.SetupErrorScreen
import org.tilecast.player.ui.SetupScaffold
import org.tilecast.player.ui.setupStep
import org.tilecast.player.ui.TvTextField
import org.tilecast.player.ui.initialFocus
import org.tilecast.player.ui.rememberInitialFocus
import org.tilecast.player.reliability.BootRecovery
import java.time.Instant
import java.time.Duration

class MainActivity : ComponentActivity() {
    private val model: PlayerViewModel by viewModels()
    private lateinit var reliability: ReliabilityController
    private lateinit var renderer: WebViewCoreRenderer
    private val captureSource by lazy { PlayerWindowCapture(this) }
    private val presentation = object : RendererPresentation {
        override fun captureBlockReason(): String? = previewCaptureBlockReason()

        override suspend fun capture(maxWidth: Int, maxHeight: Int, maxBytes: Int): WebViewCoreRenderer.CapturedImage? =
            withContext(Dispatchers.Main.immediate) {
                val view = renderer.view ?: return@withContext null
                val epoch = captureEpoch
                var detached = false
                val listener = object : android.view.View.OnAttachStateChangeListener {
                    override fun onViewAttachedToWindow(view: android.view.View) = Unit
                    override fun onViewDetachedFromWindow(view: android.view.View) { detached = true }
                }
                fun allowed() = !detached && captureEpoch == epoch &&
                    lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
                    previewCaptureBlockReason() == null && renderer.view === view &&
                    view.isShown && view.rootView === window.decorView

                if (!allowed()) return@withContext null
                view.addOnAttachStateChangeListener(listener)
                try {
                    val captured = captureSource.capture(maxWidth, maxHeight, ::allowed) as? WindowCapture.Success
                        ?: return@withContext null
                    try {
                        if (!allowed()) return@withContext null
                        val encoded = withContext(Dispatchers.Default) {
                            encodeCaptureFrame(captured.bitmap, maxBytes)
                        } ?: return@withContext null
                        if (!allowed()) return@withContext null
                        WebViewCoreRenderer.CapturedImage(encoded.bytes, encoded.width, encoded.height)
                    } finally {
                        captured.bitmap.recycle()
                    }
                } finally {
                    view.removeOnAttachStateChangeListener(listener)
                }
            }
    }
    private var adminPrompt by mutableStateOf(false)
    @Volatile private var adminVisible = false
    private var captureEpoch = 0L
    private val escapeKeys = ArrayDeque<Int>()
    private val reliabilityHandler = Handler(Looper.getMainLooper())
    private var restoreKiosk: Runnable? = null
    private val escapeSequence = listOf(KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_BACK, KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN, KeyEvent.KEYCODE_DPAD_CENTER)
    private val clockReceiver = object : BroadcastReceiver() { override fun onReceive(context: Context?, intent: Intent?) { model.onClockChanged() } }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        reliability = ReliabilityController(this)
        getSharedPreferences("tilecast-reliability", MODE_PRIVATE).edit().putBoolean("update-active", model.update.value?.state in setOf("waiting_for_permission", "waiting_for_user", "installing")).putBoolean("update-relaunch-requested", false).putInt("update-relaunch-attempts", 0).apply()
        // The view model starts Core's drivers, so it exists before the
        // renderer. The renderer's handshake still tolerates either order.
        // Activities only attach to the process-owned renderer: they never
        // create, number, or close it.
        renderer = ProcessRenderer.get(this)
        ProcessRenderer.attachPresentation(presentation)
        lifecycleScope.launch { renderer.start() }
        enableEdgeToEdge()
        WindowCompat.getInsetsController(window, window.decorView).hide(WindowInsetsCompat.Type.systemBars())
        setContent {
            TilecastSignalTheme {
                TilecastPlayer(model, renderer, adminPrompt, { showAdminPrompt(false) }, reliability)
            }
        }
    }

    override fun onStart() {
        super.onStart()
        model.onForegroundChanged(true)
        ContextCompat.registerReceiver(this, clockReceiver, IntentFilter().apply { addAction(Intent.ACTION_TIME_CHANGED); addAction(Intent.ACTION_TIMEZONE_CHANGED) }, ContextCompat.RECEIVER_NOT_EXPORTED)
        model.onClockChanged()
        model.refreshUpdatePermission()
        model.resumeUpdateSchedule()
        model.playerConfig.value?.let { reliability.applyWindow(this, it, model.activeHours.value) }
        reliabilityHandler.postDelayed({ BootRecovery.markForegroundHealthy(this); model.refreshCommissioning() }, 5000)
    }

    override fun onResume() { super.onResume(); model.refreshCommissioning() }

    override fun onStop() {
        captureEpoch++
        model.onForegroundChanged(false)
        unregisterReceiver(clockReceiver)
        super.onStop()
    }

    override fun onDestroy() {
        // The renderer outlives this Activity. Detach only what this window
        // owns: the capture hooks, and the view while it is still parented here.
        ProcessRenderer.detachPresentation(presentation)
        ProcessRenderer.releaseView(renderer.view, ownedBy = window.decorView)
        super.onDestroy()
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) { super.onWindowFocusChanged(hasFocus); if (hasFocus) model.playerConfig.value?.let { reliability.applyWindow(this, it, model.activeHours.value) } }

    // The maintenance sequence is watched before any view sees the key:
    // during playback the focused WebView consumes D-pad and Back, so the
    // sequence never reached onKeyDown. Activity.dispatchKeyEvent is public
    // framework API; lint flags it only because ComponentActivity redeclares
    // it as restricted.
    @SuppressLint("RestrictedApi")
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN && event.repeatCount == 0) {
            escapeKeys.addLast(event.keyCode)
            while (escapeKeys.size > escapeSequence.size) escapeKeys.removeFirst()
            if (escapeKeys.toList() == escapeSequence) { escapeKeys.clear(); showAdminPrompt(true); return true }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent?): Boolean =
        if (keyCode == KeyEvent.KEYCODE_BACK) true else super.onKeyDown(keyCode, event)

    private fun showAdminPrompt(value: Boolean) {
        if (adminVisible != value) captureEpoch++
        adminVisible = value
        adminPrompt = value
    }

    fun openSystemSettings(action: String) { if (!isMaintenanceSettingsLaunchAllowed(action, model.playerConfig.value?.managedKiosk?.allowSettingsDuringAdmin ?: true)) return; val intent = Intent(action).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK); if (action == Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES) intent.data = Uri.parse("package:$packageName"); runCatching { startActivity(intent) } }
    fun restartPlayer() { startActivity(Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_CLEAR_TASK or Intent.FLAG_ACTIVITY_NEW_TASK)); finish() }
    fun installPlayerUpdate() { runCatching { stopLockTask() }; getSharedPreferences("tilecast-reliability", MODE_PRIVATE).edit().putBoolean("update-active", true).apply(); model.installUpdate() }
    fun applyReliability(config: org.tilecast.player.core.CorePlatformConfig, activeHours: Boolean) { reliability.applyWindow(this, config, activeHours); restoreKiosk?.let(reliabilityHandler::removeCallbacks); reliability.maintenanceUntil()?.let { until -> Runnable { reliability.applyWindow(this, config, activeHours) }.also { restoreKiosk = it; reliabilityHandler.postDelayed(it, Duration.between(Instant.now(), until).toMillis().coerceAtLeast(0) + 100) } } }
    fun maintenanceChanged() { model.playerConfig.value?.let { applyReliability(it, model.activeHours.value) } }

    private fun previewCaptureBlockReason(): String? = when {
        adminVisible -> "sensitive_admin"
        reliability.maintenanceUntil() != null -> "sensitive_maintenance"
        model.update.value?.state in setOf("waiting_for_permission", "waiting_for_user", "installing") -> "sensitive_update"
        model.state.value !is PlayerState.PairedIdle -> "sensitive_pairing"
        else -> null
    }
}

@Composable fun TilecastPlayer(model: PlayerViewModel, renderer: WebViewCoreRenderer? = null, adminPrompt: Boolean = false, dismissAdmin: () -> Unit = {}, reliability: ReliabilityController? = null) {
    val state by model.state.collectAsStateWithLifecycle()
    val config by model.playerConfig.collectAsStateWithLifecycle()
    val update by model.update.collectAsStateWithLifecycle()
    val activeHours by model.activeHours.collectAsStateWithLifecycle()
    val safeMode by model.safeMode.collectAsStateWithLifecycle()
    val retryAt by model.retryAt.collectAsStateWithLifecycle()
    val phoneSetup by model.phoneSetup.collectAsStateWithLifecycle()
    val rendererLifecycle by (renderer?.lifecycle ?: remember { MutableStateFlow(RendererLifecycle(RendererPhase.STOPPED)) })
        .collectAsStateWithLifecycle()
    val rendererView by (renderer?.viewFlow ?: remember { MutableStateFlow<WebView?>(null) }).collectAsStateWithLifecycle()
    val activity = LocalActivity.current as? MainActivity
    LaunchedEffect(config, activeHours) { config?.let { activity?.applyReliability(it, activeHours) } }
    if (adminPrompt && reliability != null) { AdministratorMaintenance(reliability, dismissAdmin); return }
    if (update?.state in setOf("waiting_for_permission", "waiting_for_user", "installing")) { UpdateApproval(update!!, model::openUpdatePermission, { activity?.installPlayerUpdate() ?: model.installUpdate() }); return }
    if (safeMode) { Box(Modifier.fillMaxSize().background(SignalBackground), contentAlignment = Alignment.Center) { Column(horizontalAlignment = Alignment.CenterHorizontally) { TilecastBrand(); Spacer(Modifier.height(28.dp)); Text("Player recovery mode", color = SignalText, style = MaterialTheme.typography.headlineLarge); Text("Tilecast remains paired and connected. Use Studio or the local maintenance menu to retry.", color = SignalText) } }; return }
    if (state is PlayerState.PairedIdle) {
        if (rendererLifecycle.phase == RendererPhase.UNSUPPORTED) {
            val focus = rememberInitialFocus()
            CenteredMessage("Player runtime unavailable", "The installed WebView cannot host the Tilecast runtime. Update WebView from the Play Store or the device vendor, then restart Tilecast.") {
                SignalButton(onClick = { activity?.restartPlayer() }, modifier = Modifier.initialFocus(focus)) { Text("Restart Tilecast") }
            }
            return
        }
        // The WebView stays attached so its page can load, but a native
        // status surface covers it until the trusted runtime has registered
        // with Core and reported ready. A live WebView object alone is never
        // a reason to show the page, and a renderer that cannot get ready
        // shows recovery instead of an unexplained black screen.
        Box(Modifier.fillMaxSize().background(SignalBackground)) {
            rendererView?.let { view -> key(view) { AndroidView(factory = { ProcessRenderer.releaseView(view); view }, modifier = Modifier.fillMaxSize()) } }
            if (!rendererLifecycle.runtimeOwnsScreen) {
                val scope = rememberCoroutineScope()
                RendererStatusSurface(rendererLifecycle, restart = { scope.launch { renderer?.restart() } })
            }
        }
        return
    }
    // No transition between setup screens: a refreshed search result or a
    // new code must not redraw the screen or move focus.
    SetupScaffold(state.setupStep()) {
        state.let { current ->
            when (current) {
                PlayerState.Unconfigured, PlayerState.Discovering -> WithPhoneSetup(phoneSetup, model::resumePhoneSetup) {
                    SearchingScreen(emptyList(), model::chooseServer, model::showManualEntry)
                }
                is PlayerState.ServerSelection -> WithPhoneSetup(phoneSetup, model::resumePhoneSetup) {
                    SearchingScreen(current.servers, model::chooseServer, model::showManualEntry)
                }
                is PlayerState.ManualServerEntry -> WithPhoneSetup(phoneSetup, model::resumePhoneSetup) {
                    ManualEntryScreen(current.error, model::submitServerAddress, model::discover)
                }
                is PlayerState.ValidatingServer -> LoadingScreen("Connecting to ${current.serverUrl}…")
                PlayerState.PairingRequest -> LoadingScreen("Requesting a pairing code…")
                is PlayerState.WaitingForApproval -> PairingScreen(current, model::changeServer)
                PlayerState.Enrolling -> LoadingScreen("Securing this display…")
                is PlayerState.PairedConnecting -> LoadingScreen("Connecting ${current.screenName}…")
                is PlayerState.PairedIdle -> LoadingScreen("Starting playback…")
                is PlayerState.CredentialRevoked -> RevokedScreen(current.screenName)
                is PlayerState.ServerIdentityMismatch -> IdentityMismatchScreen(model::resetServer)
                is PlayerState.ConnectionError -> SetupErrorScreen(current.message, current.recoverable, retryAt, model::retryNow, model::showManualEntry) { activity?.restartPlayer() }
            }
        }
    }
}

@Composable private fun AdministratorMaintenance(reliability: ReliabilityController, dismiss: () -> Unit) {
    var pin by remember { mutableStateOf("") }
    var unlocked by remember { mutableStateOf(false) }
    var error by remember { mutableStateOf<String?>(null) }
    val activity = LocalActivity.current as? MainActivity ?: return
    val model: PlayerViewModel = viewModel()
    Box(Modifier.fillMaxSize().background(SignalBackground).padding(horizontal = SignalDimensions.ScreenHorizontal, vertical = SignalDimensions.ScreenVertical), contentAlignment = Alignment.Center) {
        if (!unlocked) {
            val focus = rememberInitialFocus()
            val submit = {
                if (pin.length >= 4) {
                    val valid = if (reliability.hasAdminPin()) reliability.verifyAdminPin(pin.toCharArray()) else runCatching { reliability.setAdminPin(pin.toCharArray()); true }.getOrDefault(false)
                    if (valid) { reliability.beginMaintenance((model.playerConfig.value?.managedKiosk?.adminSessionMinutes ?: 15L).toInt()); unlocked = true; pin = "" } else error = "PIN was incorrect or is temporarily locked"
                }
            }
            Column(Modifier.fillMaxWidth(.6f), horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(16.dp)) {
                Text(if (reliability.hasAdminPin()) "Administrator maintenance" else "Set local administrator PIN", color = SignalText, style = MaterialTheme.typography.headlineMedium)
                Text("This local PIN only opens bounded Tilecast maintenance tools. Incorrect attempts are rate-limited.", color = SignalMuted, textAlign = TextAlign.Center, style = MaterialTheme.typography.bodyLarge)
                TvTextField(value = pin, onValueChange = { pin = it.filter(Char::isDigit).take(12) }, label = "PIN", onSubmit = submit, keyboardType = KeyboardType.NumberPassword, secret = true, modifier = Modifier.initialFocus(focus))
                error?.let { Text(it, color = SignalDanger) }
                Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                    SignalButton(onClick = submit, enabled = pin.length >= 4) { Text(if (reliability.hasAdminPin()) "Unlock" else "Set PIN") }
                    SignalOutlinedButton(onClick = dismiss) { Text("Cancel") }
                }
            }
            return@Box
        }
        val back = rememberInitialFocus()
        Column(Modifier.fillMaxWidth(), verticalArrangement = Arrangement.spacedBy(14.dp)) {
            Text("Tilecast maintenance", color = SignalText, style = MaterialTheme.typography.headlineMedium)
            Text("This session expires automatically. Accessibility return and off-hours sleep are paused.", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
            Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                SignalButton(onClick = dismiss, modifier = Modifier.initialFocus(back)) { Text("Return to playback") }
                SignalOutlinedButton(onClick = { activity.restartPlayer() }) { Text("Restart Tilecast") }
                SignalOutlinedButton(onClick = { model.clearSafeMode() }) { Text("Clear safe mode") }
            }
            val settingsActions = permittedMaintenanceSettings(model.playerConfig.collectAsStateWithLifecycle().value?.managedKiosk?.allowSettingsDuringAdmin ?: true)
            if (settingsActions.isNotEmpty()) {
                Text("Optional: Accessibility Control returns to playback when another app opens, and the install permission lets signed Player updates install by themselves. Studio shows which ones this display has.", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
                Row(horizontalArrangement = Arrangement.spacedBy(10.dp)) {
                    SignalOutlinedButton(onClick = { activity.openSystemSettings(Settings.ACTION_ACCESSIBILITY_SETTINGS) }) { Text("Accessibility Settings") }
                    SignalOutlinedButton(onClick = { activity.openSystemSettings(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES) }) { Text("Install permission") }
                    SignalOutlinedButton(onClick = { activity.openSystemSettings(Settings.ACTION_SETTINGS) }) { Text("Android Settings") }
                }
            } else {
                Text("Android Settings are disabled during maintenance by this display's policy.", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
            }
            SignalOutlinedButton(onClick = { model.resetServer(); dismiss() }) { Text("Forget server and pair again") }
        }
    }
}

@Composable private fun UpdateApproval(state: UpdateUiState, permission: () -> Unit, install: () -> Unit) { Box(Modifier.fillMaxSize().background(SignalBackground).padding(72.dp), contentAlignment = Alignment.Center) { Column(horizontalAlignment = Alignment.CenterHorizontally, verticalArrangement = Arrangement.spacedBy(20.dp)) { TilecastBrand(); Text("Tilecast Player update", color = SignalText, fontSize = 44.sp, fontWeight = FontWeight.SemiBold); Text("${state.currentVersion} → ${state.newVersion}", color = SignalBlue, fontSize = 28.sp); Text(state.message, color = SignalMuted, fontSize = 21.sp); when { state.permissionRequired -> { val focus = rememberInitialFocus(); SignalButton(onClick = permission, modifier = Modifier.initialFocus(focus)) { Text("Open install permission settings") } }; state.installReady -> { val focus = rememberInitialFocus(); SignalButton(onClick = install, modifier = Modifier.initialFocus(focus)) { Text("Install update") } }; else -> CircularProgressIndicator() }; Text("Tilecast requests unattended self-update when Android supports it. Older system installers may still require local confirmation.", color = SignalWarning, fontSize = 16.sp) } } }

@Composable private fun TilecastBrand() { Image(painterResource(R.drawable.tilecast_wordmark), "Tilecast", Modifier.fillMaxWidth().height(44.dp), contentScale = ContentScale.Fit) }

/** How long the starting surface may show before it names the problem and offers recovery. */
private const val RENDERER_STALL_MS = 15_000L

@Composable private fun RendererStatusSurface(lifecycle: RendererLifecycle, restart: () -> Unit) {
    var stalled by remember(lifecycle.phase, lifecycle.generation) { mutableStateOf(false) }
    LaunchedEffect(lifecycle.phase, lifecycle.generation) { delay(RENDERER_STALL_MS); stalled = true }
    Box(Modifier.fillMaxSize().background(SignalBackground).padding(horizontal = SignalDimensions.ScreenHorizontal, vertical = SignalDimensions.ScreenVertical)) {
        if (lifecycle.phase == RendererPhase.FAILED || stalled) {
            val focus = rememberInitialFocus()
            CenteredMessage("Display unavailable", "The Tilecast display engine is not responding${lifecycle.reason?.let { " ($it)" } ?: ""}. Content resumes as soon as it recovers; you can also restart it now.") {
                SignalButton(onClick = restart, modifier = Modifier.initialFocus(focus)) { Text("Restart display") }
            }
        } else {
            LoadingScreen("Starting display…")
        }
    }
}
