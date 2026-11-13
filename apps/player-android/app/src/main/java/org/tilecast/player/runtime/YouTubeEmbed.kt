package org.tilecast.player.runtime

import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import org.tilecast.player.runtime.RemoteWebHostManager.YouTubeContent

/**
 * The host-owned YouTube wrapper document for a remote-web surface.
 *
 * The runtime supplies only validated tokens, integers and booleans
 * ([RemoteWebHostManager.validYouTube]); they reach the script as one JSON
 * literal, never as concatenated source. The wrapper reports player state
 * through the `Tilecast` interface of its own WebView, which is not the
 * trusted runtime bridge.
 */
object YouTubeEmbed {
    /** YouTube requires an https referrer identity; the app id is the stable one. */
    const val ORIGIN = "https://org.tilecast.player"
    const val BASE_URL = "$ORIGIN/"
    const val BRIDGE_NAME = "Tilecast"

    /** Maps a wrapper `report(state, detail)` call to a remote-web event, or null to ignore it. */
    fun eventFor(state: String, detail: String?): Pair<String, String?>? = when (state) {
        "ended" -> "media-ended" to null
        "ready" -> "loaded" to null
        "playing" -> "stream-ready" to null
        "player_error", "autoplay_blocked" -> "failed" to (detail ?: state)
        else -> null
    }

    /** Script that applies the host's mute and volume decision to the live player. */
    fun audioScript(muted: Boolean, volume: Int): String =
        "if(window.tilecastSetMuted){window.tilecastSetMuted($muted);}" +
            "if(window.player){window.player.setVolume(${volume.coerceIn(0, 100)});}"

    fun effectiveMute(content: YouTubeContent, surfaceMuted: Boolean, visible: Boolean): Boolean =
        content.muted || surfaceMuted || !visible

    fun html(content: YouTubeContent): String {
        val playlist = !content.playlistId.isNullOrBlank()
        val config = buildJsonObject {
            put("playlist", playlist)
            put("id", (if (playlist) content.playlistId else content.videoId).orEmpty())
            put("start", content.startSeconds)
            val end = content.endSeconds
            if (end != null) put("end", end) else put("end", JsonNull)
            put("loop", content.loop)
            put("muted", content.muted)
            put("volume", content.volume.coerceIn(0, 100))
            put("captions", content.captions)
            put("captionLanguage", content.captionLanguage)
            put("controls", content.controls)
            put("origin", ORIGIN)
        }.toString().replace("<", "\\u003c")
        return """<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="origin"><meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1"><style>html,body,#player,iframe{margin:0;width:100%;height:100%;overflow:hidden;background:transparent;border:0}</style></head><body><div id="player"></div><script>var CFG=$config;</script><script src="https://www.youtube.com/iframe_api"></script><script>
var player;var tilecastMuted=CFG.muted;
function send(s,d){try{Tilecast.report(s,d||null)}catch(e){}}
window.tilecastSetMuted=function(m){tilecastMuted=!!m;if(player){if(tilecastMuted){player.mute();}else{player.unMute();}}};
function onYouTubeIframeAPIReady(){
var vars={autoplay:1,playsinline:1,controls:CFG.controls?1:0,disablekb:1,fs:0,rel:0,start:CFG.start,loop:CFG.loop?1:0,origin:CFG.origin,cc_load_policy:CFG.captions?1:0};
if(CFG.end!==null)vars.end=CFG.end;
if(CFG.captions&&CFG.captionLanguage)vars.cc_lang_pref=CFG.captionLanguage;
var options={width:'100%',height:'100%',playerVars:vars,events:{onReady:function(e){if(tilecastMuted){e.target.mute();}else{e.target.unMute();}e.target.setVolume(CFG.volume);e.target.playVideo();send('ready')},onStateChange:function(e){var m={0:'ended',1:'playing',2:'paused',3:'buffering',5:'ready'};send(m[e.data]||'waiting')},onError:function(e){send('player_error','youtube_'+e.data)}}};
if(CFG.playlist){vars.listType='playlist';vars.list=CFG.id;}
else{options.videoId=CFG.id;if(CFG.loop)vars.playlist=CFG.id;}
player=new YT.Player('player',options);window.player=player;}
</script></body></html>"""
    }
}
