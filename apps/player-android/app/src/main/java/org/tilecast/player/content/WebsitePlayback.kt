package org.tilecast.player.content

import android.content.Context
import android.webkit.*
import org.tilecast.player.network.ManifestWebsite
import java.util.concurrent.atomic.AtomicBoolean

data class WebsitePlaybackStatus(val assetId:String?=null,val state:String="idle",val loadStartedAt:String?=null,val loadCompletedAt:String?=null,val failureCategory:String?=null,val blockedNavigationCount:Int=0,val currentHost:String?=null,val fallbackShown:Boolean=false,val rendererRecoveryCount:Int=0)

/** Evaluates clear-on-restart once per application process, not per config revision or Activity. */
object WebsiteStartupClearGate {
    private val evaluated = AtomicBoolean(false)

    fun shouldClear(configured: Boolean): Boolean = evaluated.compareAndSet(false, true) && configured

    internal fun resetForTests() {
        evaluated.set(false)
    }
}

object WebsiteNavigationPolicy {
    fun allows(raw:String,site:ManifestWebsite):Boolean=runCatching{val uri=java.net.URI(raw);if(uri.userInfo!=null||uri.host.isNullOrBlank())return false;val original=java.net.URI(site.url);val scheme=uri.scheme?.lowercase();if(scheme!="https"&&!(scheme=="http"&&original.scheme=="http"))return false;val port=uri.port;if(port!=-1&&port!=if(scheme=="https")443 else 80)return false;site.allowedHosts.any{it.equals(uri.host?.trimEnd('.'),true)}}.getOrDefault(false)
}

object WebsiteDataManager {
    fun clear(context:Context,complete:(Boolean)->Unit){android.os.Handler(android.os.Looper.getMainLooper()).post{runCatching{CookieManager.getInstance().removeAllCookies{WebStorage.getInstance().deleteAllData();val web=WebView(context.applicationContext);web.clearCache(true);web.clearHistory();web.destroy();complete(true)}}.onFailure{complete(false)}}}
}
