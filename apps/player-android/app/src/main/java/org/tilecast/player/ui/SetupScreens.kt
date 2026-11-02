package org.tilecast.player.ui

import android.content.Context
import android.graphics.Bitmap
import android.net.ConnectivityManager
import android.os.Build
import android.os.SystemClock
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ColumnScope
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.itemsIndexed
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import com.google.zxing.BarcodeFormat
import com.google.zxing.qrcode.QRCodeWriter
import java.net.Inet4Address
import java.time.Duration
import java.time.Instant
import kotlinx.coroutines.delay
import org.tilecast.player.BuildConfig
import org.tilecast.player.R
import org.tilecast.player.core.CorePhoneSetup
import org.tilecast.player.core.DiscoveredServer
import org.tilecast.player.core.PlayerState
import org.tilecast.player.ui.theme.SignalBackground
import org.tilecast.player.ui.theme.SignalBlue
import org.tilecast.player.ui.theme.SignalBlueSoft
import org.tilecast.player.ui.theme.SignalBorder
import org.tilecast.player.ui.theme.SignalButton
import org.tilecast.player.ui.theme.SignalDanger
import org.tilecast.player.ui.theme.SignalDimensions
import org.tilecast.player.ui.theme.SignalMuted
import org.tilecast.player.ui.theme.SignalOutlinedButton
import org.tilecast.player.ui.theme.SignalSurface
import org.tilecast.player.ui.theme.SignalSurfaceElevated
import org.tilecast.player.ui.theme.SignalText
import org.tilecast.player.ui.theme.SignalWarning
import org.tilecast.player.ui.theme.signalTvFocus

/*
 * The setup screens. Each one either needs nothing from the installer or
 * opens with its one useful control focused, so a remote's OK button always
 * does the expected thing. Nothing here shows raw errors or internal IDs.
 */

/** Where setup is, for the progress indicator: find a server, approve, play. */
enum class SetupStep(val label: String) { Connect("Connect"), Approve("Approve"), Play("Play") }

fun PlayerState.setupStep(): SetupStep = when (this) {
    is PlayerState.WaitingForApproval, PlayerState.PairingRequest, is PlayerState.CredentialRevoked -> SetupStep.Approve
    PlayerState.Enrolling, is PlayerState.PairedConnecting, is PlayerState.PairedIdle -> SetupStep.Play
    else -> SetupStep.Connect
}

/**
 * The frame every setup screen shares: the wordmark and progress across the
 * top, the screen's content in the middle, and the facts an installer looks
 * for (Player version, device, and this display's network address) below.
 */
@Composable
fun SetupScaffold(step: SetupStep, content: @Composable () -> Unit) {
    Column(
        Modifier
            .fillMaxSize()
            .background(SignalBackground)
            .padding(horizontal = SignalDimensions.ScreenHorizontal, vertical = 36.dp),
    ) {
        Row(Modifier.fillMaxWidth(), verticalAlignment = Alignment.CenterVertically) {
            Image(
                painterResource(R.drawable.tilecast_wordmark),
                "Tilecast",
                Modifier.height(26.dp),
                contentScale = ContentScale.Fit,
                alignment = Alignment.CenterStart,
            )
            Spacer(Modifier.weight(1f))
            SetupProgress(step)
        }
        Box(Modifier.weight(1f).fillMaxWidth().padding(vertical = 24.dp), contentAlignment = Alignment.CenterStart) {
            content()
        }
        DeviceFooter()
    }
}

@Composable
private fun SetupProgress(current: SetupStep) {
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(10.dp)) {
        SetupStep.entries.forEachIndexed { index, step ->
            if (index > 0) Box(Modifier.width(28.dp).height(1.dp).background(SignalBorder))
            val done = step.ordinal < current.ordinal
            val active = step == current
            Box(
                Modifier
                    .size(24.dp)
                    .clip(CircleShape)
                    .background(if (active) SignalBlue else if (done) SignalBlueSoft else Color.Transparent)
                    .border(1.dp, if (active || done) SignalBlue else SignalBorder, CircleShape),
                contentAlignment = Alignment.Center,
            ) {
                if (done) {
                    TvIcon(TvIcons.Check, SignalBlue, size = 14.dp, description = "Done")
                } else {
                    Text("${index + 1}", color = if (active) SignalBackground else SignalMuted, fontSize = 12.sp, fontWeight = FontWeight.SemiBold)
                }
            }
            Text(step.label, color = if (active) SignalText else SignalMuted, style = MaterialTheme.typography.labelLarge)
        }
    }
}

@Composable
private fun DeviceFooter() {
    val context = LocalContext.current
    val address = remember { localAddress(context) }
    Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(8.dp)) {
        TvIcon(TvIcons.Tv, SignalMuted, size = 16.dp)
        Text(
            listOfNotNull("Tilecast Player ${BuildConfig.VERSION_NAME}", Build.MODEL?.takeIf { it.isNotBlank() }).joinToString("   ·   "),
            color = SignalMuted,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (address != null) {
            Spacer(Modifier.width(16.dp))
            TvIcon(TvIcons.Network, SignalMuted, size = 16.dp)
            Text("This display: $address", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
        }
    }
}

private fun localAddress(context: Context): String? = runCatching {
    val connectivity = context.getSystemService(ConnectivityManager::class.java)
    connectivity.getLinkProperties(connectivity.activeNetwork)
        ?.linkAddresses
        ?.map { it.address }
        ?.firstOrNull { it is Inet4Address && !it.isLoopbackAddress }
        ?.hostAddress
}.getOrNull()

/** A quiet surface that groups one screen's content. */
@Composable
private fun Panel(modifier: Modifier = Modifier, content: @Composable ColumnScope.() -> Unit) {
    Column(
        modifier
            .clip(RoundedCornerShape(SignalDimensions.PanelRadius))
            .background(SignalSurface)
            .border(1.dp, SignalBorder, RoundedCornerShape(SignalDimensions.PanelRadius))
            .padding(24.dp),
        content = content,
    )
}

/** An icon in a soft square, leading a panel or a list row. */
@Composable
private fun IconTile(icon: Int, tint: Color = SignalBlue, background: Color = SignalBlueSoft) {
    Box(
        Modifier.size(44.dp).clip(RoundedCornerShape(SignalDimensions.PanelRadius)).background(background),
        contentAlignment = Alignment.Center,
    ) { TvIcon(icon, tint, size = 22.dp) }
}

@Composable
private fun ScreenTitle(title: String, body: String? = null) {
    Text(title, color = SignalText, style = MaterialTheme.typography.headlineMedium)
    body?.let {
        Spacer(Modifier.height(8.dp))
        Text(it, color = SignalMuted, style = MaterialTheme.typography.bodyLarge)
    }
}

/**
 * A setup screen with the phone setup QR code beside it while Core runs
 * phone setup (docs/phone-setup.md). The screen keeps its own layout on
 * the left; the panel takes the free space on the right.
 */
@Composable
fun WithPhoneSetup(phone: CorePhoneSetup?, resume: () -> Unit, content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.CenterStart) {
        content()
        val side = Modifier.align(Alignment.CenterEnd).fillMaxWidth(.32f)
        when (phone) {
            is CorePhoneSetup.Ready -> PhoneSetupPanel(phone, side)
            CorePhoneSetup.Paused -> PhoneSetupPaused(resume, side)
            CorePhoneSetup.Unavailable, null -> Unit
        }
    }
}

@Composable
private fun PhoneSetupPanel(phone: CorePhoneSetup.Ready, modifier: Modifier) {
    val qr = remember(phone.url) { qrCode(phone.url) }
    Panel(modifier) {
        Image(
            qr.asImageBitmap(),
            "QR code for phone setup",
            Modifier
                .align(Alignment.CenterHorizontally)
                .size(200.dp)
                .clip(RoundedCornerShape(SignalDimensions.PanelRadius))
                .background(Color.White)
                .padding(12.dp),
        )
        Spacer(Modifier.height(16.dp))
        Row(verticalAlignment = Alignment.CenterVertically) {
            TvIcon(TvIcons.QrCode, SignalBlue, size = 18.dp)
            Spacer(Modifier.width(10.dp))
            Text("Set up with your phone", color = SignalText, style = MaterialTheme.typography.titleLarge)
        }
        Spacer(Modifier.height(6.dp))
        Text(
            "Scan this code with your phone's camera, then continue in Tilecast Studio.",
            color = SignalMuted,
            style = MaterialTheme.typography.bodyMedium,
        )
        if (phone.rejected) {
            Spacer(Modifier.height(10.dp))
            Row {
                TvIcon(TvIcons.Warning, SignalWarning, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text(
                    "The address from the phone could not be used. Scan the code to try again.",
                    color = SignalWarning,
                    style = MaterialTheme.typography.bodyMedium,
                )
            }
        }
    }
}

@Composable
private fun PhoneSetupPaused(resume: () -> Unit, modifier: Modifier) {
    Panel(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            IconTile(TvIcons.QrCode)
            Spacer(Modifier.width(16.dp))
            Column {
                Text("Phone setup paused", color = SignalText, style = MaterialTheme.typography.titleLarge)
                Text("The setup code stopped after 30 minutes.", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
            }
        }
        Spacer(Modifier.height(16.dp))
        SignalOutlinedButton(onClick = resume) { ButtonLabel(TvIcons.QrCode, "Show setup code") }
    }
}

/** Searching, or choosing between several servers that answered. */
@Composable
fun SearchingScreen(servers: List<DiscoveredServer>, choose: (DiscoveredServer) -> Unit, manual: () -> Unit) {
    if (servers.isEmpty()) {
        val focus = rememberInitialFocus()
        Column(Modifier.fillMaxWidth(.62f)) {
            ScreenTitle("Connect to Tilecast Server", "Keep this display on the same network as your server. It connects by itself when it finds one.")
            Spacer(Modifier.height(24.dp))
            Panel(Modifier.fillMaxWidth()) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    IconTile(TvIcons.Radar)
                    Spacer(Modifier.width(16.dp))
                    Column(Modifier.weight(1f)) {
                        Text("Searching this network…", color = SignalText, style = MaterialTheme.typography.titleLarge)
                        Text(
                            "Some networks block automatic discovery. You can enter the address you use to open Tilecast Studio instead.",
                            color = SignalMuted,
                            style = MaterialTheme.typography.bodyMedium,
                        )
                    }
                    Spacer(Modifier.width(16.dp))
                    CircularProgressIndicator(color = SignalBlue, strokeWidth = 3.dp, modifier = Modifier.size(22.dp))
                }
                Spacer(Modifier.height(20.dp))
                SignalButton(onClick = manual, modifier = Modifier.initialFocus(focus)) { ButtonLabel(TvIcons.Keyboard, "Enter server address") }
            }
        }
        return
    }
    val focus = rememberInitialFocus(servers.first().baseUrl)
    Column(Modifier.fillMaxWidth(.62f).fillMaxHeight(), verticalArrangement = Arrangement.Center) {
        ScreenTitle("Choose your server", "More than one Tilecast Server answered on this network.")
        Spacer(Modifier.height(20.dp))
        LazyColumn(Modifier.weight(1f, fill = false), verticalArrangement = Arrangement.spacedBy(10.dp)) {
            itemsIndexed(servers, key = { _, server -> server.baseUrl }) { index, server ->
                ServerRow(server, { choose(server) }, Modifier.initialFocus(if (index == 0) focus else null))
            }
        }
        Spacer(Modifier.height(16.dp))
        SignalOutlinedButton(onClick = manual) { ButtonLabel(TvIcons.Keyboard, "Enter server address") }
    }
}

/** A button label with a leading icon in the label's own colour. */
@Composable
private fun ButtonLabel(icon: Int, label: String) {
    Icon(painterResource(icon), null, Modifier.size(18.dp))
    Spacer(Modifier.width(10.dp))
    Text(label)
}

@Composable
private fun ServerRow(server: DiscoveredServer, choose: () -> Unit, modifier: Modifier) {
    SignalOutlinedButton(onClick = choose, modifier = modifier.fillMaxWidth()) {
        Row(Modifier.fillMaxWidth().padding(vertical = 8.dp), verticalAlignment = Alignment.CenterVertically) {
            IconTile(TvIcons.Server)
            Spacer(Modifier.width(16.dp))
            Column {
                Text(server.name, color = SignalText, style = MaterialTheme.typography.titleLarge)
                Text(server.baseUrl, color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
fun ManualEntryScreen(error: String?, connect: (String) -> Unit, search: () -> Unit) {
    var address by remember { mutableStateOf("") }
    val focus = rememberInitialFocus()
    val submit = { if (address.isNotBlank()) connect(address) }
    Column(Modifier.fillMaxWidth(.62f)) {
        ScreenTitle("Enter the server address", "Use the address you open Tilecast Studio with.")
        Spacer(Modifier.height(24.dp))
        TvTextField(
            value = address,
            onValueChange = { address = it.trim() },
            label = "Server address",
            onSubmit = submit,
            modifier = Modifier.fillMaxWidth().initialFocus(focus),
        )
        Spacer(Modifier.height(8.dp))
        if (error != null) {
            Text(error, color = SignalDanger, style = MaterialTheme.typography.bodyMedium)
        } else {
            Text("For example 192.168.1.50:8080 or signage.example.com", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
        }
        Spacer(Modifier.height(24.dp))
        Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
            SignalButton(onClick = submit, enabled = address.isNotBlank()) { Text("Connect") }
            SignalOutlinedButton(onClick = search) { ButtonLabel(TvIcons.Search, "Search the network") }
        }
    }
}

@Composable
fun PairingScreen(state: PlayerState.WaitingForApproval, changeServer: () -> Unit) {
    val total = runCatching { Duration.between(Instant.parse(state.pairing.serverTime), Instant.parse(state.pairing.expiresAt)).seconds }.getOrNull()
    var remaining by remember(state.pairing.code) { mutableLongStateOf(total ?: 0) }
    LaunchedEffect(state.pairing.code) {
        if (total == null) return@LaunchedEffect
        val started = SystemClock.elapsedRealtime()
        while (true) {
            remaining = (total - (SystemClock.elapsedRealtime() - started) / 1_000).coerceAtLeast(0)
            delay(1_000)
        }
    }
    val qr = remember(state.pairing.approvalUrl) { qrCode(state.pairing.approvalUrl) }
    // No control takes focus here: the screen waits for Studio, and a stray
    // OK press must not throw the code away.
    Row(Modifier.fillMaxSize(), horizontalArrangement = Arrangement.spacedBy(40.dp), verticalAlignment = Alignment.CenterVertically) {
        Column(Modifier.weight(1f)) {
            ScreenTitle(
                if (state.organizationName.isNotBlank()) "Approve this display for ${state.organizationName}" else "Approve this display",
                "In Tilecast Studio, choose Pair screen and enter this code.",
            )
            Spacer(Modifier.height(24.dp))
            PairingCode(state.pairing.code)
            Spacer(Modifier.height(20.dp))
            val details = listOfNotNull(
                state.serverUrl.takeIf { it.isNotBlank() },
                total?.let { "New code in ${remaining / 60}:${(remaining % 60).toString().padStart(2, '0')}" },
            )
            if (details.isNotEmpty()) {
                Text(details.joinToString("   ·   "), color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
            }
            if (state.localInsecure) {
                Spacer(Modifier.height(6.dp))
                Row(verticalAlignment = Alignment.CenterVertically) {
                    TvIcon(TvIcons.Warning, SignalWarning, size = 16.dp)
                    Spacer(Modifier.width(8.dp))
                    Text("Local network connection over HTTP. Traffic is not encrypted.", color = SignalWarning, style = MaterialTheme.typography.bodyMedium)
                }
            }
            Spacer(Modifier.height(20.dp))
            SignalOutlinedButton(onClick = changeServer) { ButtonLabel(TvIcons.Server, "Change server") }
        }
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            Image(
                qr.asImageBitmap(),
                "QR code for pairing approval",
                Modifier.size(200.dp).clip(RoundedCornerShape(SignalDimensions.PanelRadius)).background(Color.White).padding(12.dp),
            )
            Spacer(Modifier.height(12.dp))
            Row(verticalAlignment = Alignment.CenterVertically) {
                TvIcon(TvIcons.QrCode, SignalMuted, size = 16.dp)
                Spacer(Modifier.width(8.dp))
                Text("Or scan to approve", color = SignalMuted, style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

/** The code as individual tiles in two groups of three, easy to read from across a room. */
@Composable
private fun PairingCode(code: String) {
    Row(horizontalArrangement = Arrangement.spacedBy(10.dp), verticalAlignment = Alignment.CenterVertically) {
        code.chunked(3).forEachIndexed { group, part ->
            if (group > 0) Spacer(Modifier.width(12.dp))
            part.forEach { character ->
                Box(
                    Modifier
                        .size(width = 60.dp, height = 76.dp)
                        .clip(RoundedCornerShape(SignalDimensions.PanelRadius))
                        .background(SignalSurfaceElevated)
                        .border(1.dp, SignalBorder, RoundedCornerShape(SignalDimensions.PanelRadius)),
                    contentAlignment = Alignment.Center,
                ) {
                    Text(character.toString(), color = SignalText, fontSize = 44.sp, lineHeight = 52.sp, fontWeight = FontWeight.SemiBold)
                }
            }
        }
    }
}

@Composable
fun LoadingScreen(message: String) {
    Column(Modifier.fillMaxSize(), verticalArrangement = Arrangement.Center, horizontalAlignment = Alignment.CenterHorizontally) {
        CircularProgressIndicator(color = SignalBlue, strokeWidth = 3.dp, modifier = Modifier.size(36.dp))
        Spacer(Modifier.height(20.dp))
        Text(message, color = SignalText, style = MaterialTheme.typography.titleLarge, textAlign = TextAlign.Center)
    }
}

/** Shown briefly while the Player asks the same server for a new code. */
@Composable
fun RevokedScreen(name: String?) {
    CenteredMessage(
        title = "${name ?: "This display"} was removed from Tilecast Studio",
        message = "Getting a new pairing code so it can be approved again…",
        icon = TvIcons.Unplug,
        busy = true,
    )
}

@Composable
fun IdentityMismatchScreen(reset: () -> Unit) {
    val focus = rememberInitialFocus()
    NoticePanel(
        icon = TvIcons.Shield,
        tone = SignalWarning,
        title = "This server has changed",
        message = "The address now belongs to a different Tilecast installation, so this display did not send its credentials. Reset the connection to pair with the new server.",
    ) {
        SignalButton(onClick = reset, modifier = Modifier.initialFocus(focus)) { ButtonLabel(TvIcons.Search, "Reset and search again") }
    }
}

/**
 * A setup problem. Recoverable problems retry by themselves and show when;
 * the buttons only make it happen sooner or change course.
 */
@Composable
fun SetupErrorScreen(
    message: String,
    recoverable: Boolean,
    retryAt: Long?,
    retryNow: () -> Unit,
    manual: () -> Unit,
    restart: () -> Unit,
) {
    val focus = rememberInitialFocus(recoverable)
    var now by remember { mutableLongStateOf(System.currentTimeMillis()) }
    LaunchedEffect(retryAt) {
        while (retryAt != null) {
            now = System.currentTimeMillis()
            delay(1_000)
        }
    }
    val countdown = retryAt?.let { ((it - now) / 1_000).coerceAtLeast(0) }
    NoticePanel(
        icon = if (recoverable) TvIcons.Warning else TvIcons.Error,
        tone = if (recoverable) SignalWarning else SignalDanger,
        title = if (recoverable) "Can't connect yet" else "Tilecast needs to restart",
        message = message,
        detail = countdown?.let { "Trying again in $it s" },
    ) {
        if (recoverable) {
            Row(horizontalArrangement = Arrangement.spacedBy(12.dp)) {
                SignalButton(onClick = retryNow, modifier = Modifier.initialFocus(focus)) { ButtonLabel(TvIcons.Retry, "Try again now") }
                SignalOutlinedButton(onClick = manual) { ButtonLabel(TvIcons.Keyboard, "Enter server address") }
            }
        } else {
            SignalButton(onClick = restart, modifier = Modifier.initialFocus(focus)) { ButtonLabel(TvIcons.Retry, "Restart Tilecast") }
        }
    }
}

/** A problem that needs attention: an icon in its tone, the title, and what happens next. */
@Composable
private fun NoticePanel(icon: Int, tone: Color, title: String, message: String, detail: String? = null, actions: @Composable () -> Unit) {
    Panel(Modifier.fillMaxWidth(.66f)) {
        Row(verticalAlignment = Alignment.Top) {
            IconTile(icon, tint = tone, background = tone.copy(alpha = .14f))
            Spacer(Modifier.width(20.dp))
            Column {
                Text(title, color = SignalText, style = MaterialTheme.typography.headlineMedium)
                Spacer(Modifier.height(8.dp))
                Text(message, color = SignalMuted, style = MaterialTheme.typography.bodyLarge)
                detail?.let {
                    Spacer(Modifier.height(8.dp))
                    Text(it, color = tone, style = MaterialTheme.typography.bodyMedium)
                }
                Spacer(Modifier.height(20.dp))
                actions()
            }
        }
    }
}

@Composable
fun CenteredMessage(title: String, message: String, icon: Int? = null, busy: Boolean = false, actions: @Composable () -> Unit = {}) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(Modifier.fillMaxWidth(.66f), horizontalAlignment = Alignment.CenterHorizontally) {
            if (icon != null) {
                IconTile(icon)
                Spacer(Modifier.height(20.dp))
            } else if (busy) {
                CircularProgressIndicator(color = SignalBlue, strokeWidth = 3.dp, modifier = Modifier.size(36.dp))
                Spacer(Modifier.height(20.dp))
            }
            Text(title, color = SignalText, style = MaterialTheme.typography.headlineMedium, textAlign = TextAlign.Center)
            Spacer(Modifier.height(10.dp))
            Text(message, color = SignalMuted, style = MaterialTheme.typography.bodyLarge, textAlign = TextAlign.Center)
            if (icon != null && busy) {
                Spacer(Modifier.height(20.dp))
                CircularProgressIndicator(color = SignalBlue, strokeWidth = 3.dp, modifier = Modifier.size(28.dp))
            }
            Spacer(Modifier.height(24.dp))
            actions()
        }
    }
}

private fun qrCode(value: String): Bitmap {
    val matrix = QRCodeWriter().encode(value, BarcodeFormat.QR_CODE, 420, 420)
    return Bitmap.createBitmap(420, 420, Bitmap.Config.RGB_565).apply {
        for (x in 0 until 420) for (y in 0 until 420) setPixel(x, y, if (matrix[x, y]) android.graphics.Color.BLACK else android.graphics.Color.WHITE)
    }
}
