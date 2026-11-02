package org.tilecast.player.ui

import androidx.annotation.DrawableRes
import androidx.compose.material3.Icon
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.res.painterResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.foundation.layout.size
import com.composables.icons.lucide.R as Lucide

/** The Lucide icons the native screens use, the same set Studio draws. */
object TvIcons {
    @DrawableRes val Search = Lucide.drawable.lucide_ic_search
    @DrawableRes val Server = Lucide.drawable.lucide_ic_server
    @DrawableRes val Keyboard = Lucide.drawable.lucide_ic_keyboard
    @DrawableRes val Check = Lucide.drawable.lucide_ic_check
    @DrawableRes val Warning = Lucide.drawable.lucide_ic_triangle_alert
    @DrawableRes val Error = Lucide.drawable.lucide_ic_circle_alert
    @DrawableRes val Shield = Lucide.drawable.lucide_ic_shield_alert
    @DrawableRes val Unplug = Lucide.drawable.lucide_ic_unplug
    @DrawableRes val Retry = Lucide.drawable.lucide_ic_refresh_cw
    @DrawableRes val QrCode = Lucide.drawable.lucide_ic_qr_code
    @DrawableRes val Tv = Lucide.drawable.lucide_ic_tv
    @DrawableRes val Network = Lucide.drawable.lucide_ic_network
    @DrawableRes val Radar = Lucide.drawable.lucide_ic_radar
}

/** A decorative or labelled Lucide icon. Pass a description when the icon carries meaning on its own. */
@Composable
fun TvIcon(@DrawableRes icon: Int, tint: Color, size: Dp = 20.dp, description: String? = null, modifier: Modifier = Modifier) {
    Icon(painterResource(icon), description, modifier.size(size), tint = tint)
}
