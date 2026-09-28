package org.tilecast.player.runtime

import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonArray
import kotlinx.serialization.json.putJsonObject

/** Typed page-to-native channel vocabulary for the Android runtime host.
 *
 * The page reaches native code only through the origin-bound
 * `window.tilecastRuntimeHostV1` listener object installed by
 * [TrustedRuntimeWebView]. Native answers call and state requests through
 * the reply proxy of the received message; pushes are announced with a
 * numeric-only [RuntimeBridgeProtocol.nudgeJs] evaluation and pulled by the
 * page. Presentation payloads never travel inside evaluated JS source.
 */
object HostChannel {
    private val json = Json { ignoreUnknownKeys = true }

    sealed interface PageMessage {
        data class StateWant(val wantGeneration: Long?) : PageMessage
        data class Call(val id: String, val call: String, val payload: JsonObject) : PageMessage
        data class Report(val raw: String) : PageMessage
        data object EventsWant : PageMessage
    }

    fun parsePageMessage(raw: String): PageMessage? {
        if (raw.isBlank() || raw.length > 2_000_000) return null
        val obj = runCatching { json.parseToJsonElement(raw).jsonObject }.getOrNull() ?: return null
        return when (obj["type"]?.jsonPrimitive?.contentOrNull) {
            "host-state" -> PageMessage.StateWant(
                obj["wantGeneration"]?.jsonPrimitive?.longOrNull,
            )
            "host-events" -> PageMessage.EventsWant
            "host-call" -> {
                val id = obj["id"]?.jsonPrimitive?.contentOrNull
                    ?.take(64)?.takeIf { it.isNotBlank() } ?: return null
                val call = obj["call"]?.jsonPrimitive?.contentOrNull
                    ?.take(64)?.takeIf { it.isNotBlank() } ?: return null
                val payload = obj["payload"] as? JsonObject ?: return null
                PageMessage.Call(id, call, payload)
            }
            else -> RuntimeBridgeProtocol.parseRuntimeReport(raw)?.let { PageMessage.Report(raw) }
        }
    }

    fun stateBundle(generation: Long, messages: List<JsonObject>): String =
        buildJsonObject {
            put("type", "host-state")
            put("generation", generation)
            putJsonArray("messages") { messages.forEach { add(it) } }
        }.toString()

    /** Pushes one remote-web event to an armed page (see `host-events`). */
    fun remoteEvent(surfaceId: String?, kind: String, code: String?): String =
        buildJsonObject {
            put("type", "host-event")
            putJsonObject("event") {
                if (surfaceId != null) put("surfaceId", surfaceId.take(48))
                put("kind", kind.take(32))
                code?.take(64)?.let { put("code", it) }
            }
        }.toString()

    fun callResult(id: String, ok: Boolean, result: JsonElement?, code: String?): String =
        buildJsonObject {
            put("type", "host-call-result")
            put("id", id.take(64))
            put("ok", ok)
            if (ok && result != null) put("result", result)
            if (!ok) put("code", (code ?: "failed").take(64))
        }.toString()

    private fun sanitized(value: String): String =
        value.take(32).filter { it.isLetterOrDigit() || it == '.' || it == '_' || it == '-' }

    /** Document-start adapter publishing `globalThis.tilecastRuntimeHost`.
     *
     * Mirrors the Electron preload and WPE bridge structure: a local listener
     * set with presentation/plugin replay, typed reports to native, and
     * request/response remote-web calls. Remote pages never execute this
     * script: it is injected only on the trusted runtime origin.
     */
    fun installScript(hostVersion: String, engineVersion: String): String {
        val host = sanitized(hostVersion).ifBlank { "unknown" }
        val engine = sanitized(engineVersion).ifBlank { "unknown" }
        return """
        (function(){
        if(window.__tilecastHostInstalled)return;
        window.__tilecastHostInstalled=true;
        window.__tilecastHostReady=true;
        var NATIVE="tilecastRuntimeHostV1";
        var listeners=new Set();
        var lastPresentation=null,lastPlugins=null;
        var stateGeneration=-1;
        var callSeq=0;
        var callResolvers={};
        function nativePort(){try{return window[NATIVE]||null;}catch(e){return null;}}
        var onmessageAttached=false;
        function attachReplies(port){
          if(onmessageAttached||!port)return;
          try{port.onmessage=function(event){onNativeMessage(event.data);};onmessageAttached=true;}catch(e){}
        }
        function postToNative(obj){
          var port=nativePort();
          if(!port||!port.postMessage)return false;
          attachReplies(port);
          try{port.postMessage(JSON.stringify(obj));}catch(e){return false;}
          return true;
        }
        function emit(message){
          if(!message||typeof message.type!=="string")return;
          if(message.type==="presentation")lastPresentation=message;
          if(message.type==="plugins")lastPlugins=message;
          listeners.forEach(function(listener){
            try{listener(message);}catch(e){console.error("tilecast host listener failed",e);}
          });
        }
        window.__tilecastHostNudge=function(gen){
          postToNative({type:"host-state",wantGeneration:(typeof gen==="number"?gen:-1)});
        };
        function armEvents(){postToNative({type:"host-events"});}
        function onNativeMessage(data){
          var message=null;
          try{message=JSON.parse(data);}catch(e){return;}
          if(!message||typeof message.type!=="string")return;
          if(message.type==="host-state"){
            if(typeof message.generation!=="number"||message.generation<=stateGeneration)return;
            stateGeneration=message.generation;
            var items=message.messages;
            if(Object.prototype.toString.call(items)!=="[object Array]")return;
            items.forEach(emit);
            return;
          }
          if(message.type==="host-call-result"){
            var resolve=callResolvers[message.id];
            if(resolve){delete callResolvers[message.id];resolve(message);}
            return;
          }
          if(message.type==="host-event"){
            if(message.event&&typeof message.event.kind==="string")emit({type:"remote-web",event:message.event});
            armEvents();
            return;
          }
        }
        function requestCall(call,payload){
          return new Promise(function(resolve){
            var id="c"+(++callSeq)+"."+Date.now().toString(36);
            callResolvers[id]=resolve;
            if(!postToNative({type:"host-call",id:id,call:call,payload:payload||{}})){
              delete callResolvers[id];
              resolve({ok:false,code:"bridge_unavailable"});
            }
          });
        }
        function fire(call,payload){postToNative({type:"host-call",id:"",call:call,payload:payload||{}});}
        window.tilecastRuntimeHost={
          contractVersion:1,
          info:{host:"android",hostVersion:"HOSTVERSION",engine:"android-webview",engineVersion:"ENGINEVERSION"},
          capabilities:{remoteWeb:"host-view",synchronizedPlayback:true,setup:false,discovery:false},
          subscribe:function(listener){
            listeners.add(listener);
            if(lastPresentation)listener(lastPresentation);
            if(lastPlugins)listener(lastPlugins);
            return function(){listeners.delete(listener);};
          },
          ready:function(ready){
            postToNative({type:"ready",contractVersion:1,runtimeVersion:String((ready&&ready.runtimeVersion)||"unknown").slice(0,64)});
            postToNative({type:"host-state",wantGeneration:-1});
            armEvents();
          },
          presentationResult:function(result){postToNative({type:"presentation-result",outcome:result.outcome,activation:result.activation||null,message:String(result.message||"").slice(0,240)});},
          reportEvidence:function(report){postToNative({type:"evidence",activation:report.activation||null,itemId:report.itemId||null,kind:report.kind,zoneId:report.zoneId||null});},
          reportPlaybackError:function(report){postToNative({type:"playback-error",activation:report.activation||null,itemId:report.itemId||null,message:String(report.message||"").slice(0,240)});},
          remoteWeb:{
            reportRecovered:function(){fire("remoteWeb.reportRecovered",{});},
            create:function(spec){return requestCall("remoteWeb.create",spec);},
            updateViewport:function(surfaceId,viewport){fire("remoteWeb.updateViewport",{surfaceId:surfaceId,viewport:viewport});},
            setVisible:function(surfaceId,visible){fire("remoteWeb.setVisible",{surfaceId:surfaceId,visible:!!visible});},
            setMuted:function(surfaceId,muted){fire("remoteWeb.setMuted",{surfaceId:surfaceId,muted:!!muted});},
            reload:function(surfaceId){fire("remoteWeb.reload",{surfaceId:surfaceId});},
            destroy:function(surfaceId){fire("remoteWeb.destroy",{surfaceId:surfaceId});}
          }
        };
        })();
        """.trimIndent()
            .replace("HOSTVERSION", host)
            .replace("ENGINEVERSION", engine)
    }
}
