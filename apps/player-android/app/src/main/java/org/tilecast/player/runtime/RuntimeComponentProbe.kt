package org.tilecast.player.runtime

import android.webkit.WebView
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

/**
 * App-owned Widget V2 runtime feature probe (Android PR3 step 9).
 *
 * Android API level never proves the installed WebView can run the Widget
 * runtime contract, so the trusted document proves the actual semantics the
 * current Widget implementation needs: custom elements, Shadow DOM,
 * constructed/adopted stylesheets, container queries and units, CSP
 * enforcement of the no-inline-style contract with working CSSOM bindings,
 * and the Web Animations API the stage transitions use. The result gates
 * component capability advertisement; WebView package/version stays
 * diagnostics-only. Heartbeat evidence behavior is covered by conformance
 * assertions rather than this probe.
 */
object RuntimeComponentProbe {
    @Volatile
    var passed: Boolean = false
        private set

    fun record(passed: Boolean) {
        this.passed = passed
    }

    /** Runs the probe in the trusted document; records the parsed outcome. */
    fun run(webView: WebView, onDone: (Boolean) -> Unit = {}) {
        webView.post {
            runCatching {
                webView.evaluateJavascript(PROBE_SCRIPT) { raw ->
                    val result = parseResult(raw)
                    record(result)
                    onDone(result)
                }
            }.onFailure { onDone(false) }
        }
    }

    /** True only when every probed semantic reports support. */
    fun parseResult(raw: String?): Boolean {
        if (raw.isNullOrBlank() || raw == "null") return false
        val decoded = runCatching {
            Json.parseToJsonElement(raw).jsonPrimitive.content
        }.getOrNull() ?: return false
        val flags = runCatching {
            Json.parseToJsonElement(decoded).jsonObject
        }.getOrNull() ?: return false
        return REQUIRED_FLAGS.all { key ->
            flags[key]?.jsonPrimitive?.booleanOrNull == true
        }
    }

    private val REQUIRED_FLAGS = listOf(
        "customElements",
        "shadowDOM",
        "adoptedStyleSheets",
        "containerQueries",
        "containerUnits",
        "cspBlocksInlineStyle",
        "cssomStyle",
        "webAnimations",
    )

    // App-owned semantics check only: no network, no storage, no exfiltration.
    // evaluateJavascript stringifies the return value, hence the outer JSON
    // string that parseResult unwraps before reading the flags.
    const val PROBE_SCRIPT =
        "(function(){var out={};" +
            "try{var n='tc-probe-'+Math.floor(Math.random()*1e9);" +
            "customElements.define(n,class extends HTMLElement{});" +
            "out.customElements=!!customElements.get(n);}catch(e){out.customElements=false;}" +
            "try{out.shadowDOM=!!document.createElement('div').attachShadow({mode:'open'});}catch(e){out.shadowDOM=false;}" +
            "try{var s=new CSSStyleSheet();s.replaceSync('.x{color:red}');" +
            "var h=document.createElement('div');h.attachShadow({mode:'open'});" +
            "h.shadowRoot.adoptedStyleSheets=[s];" +
            "out.adoptedStyleSheets=h.shadowRoot.adoptedStyleSheets.length===1;}catch(e){out.adoptedStyleSheets=false;}" +
            "try{out.containerQueries=CSS.supports('container-type: inline-size');}catch(e){out.containerQueries=false;}" +
            "try{out.containerUnits=CSS.supports('width: 1cqw');}catch(e){out.containerUnits=false;}" +
            "try{var el=document.createElement('div');document.documentElement.appendChild(el);" +
            "el.setAttribute('style','color: rgb(255, 0, 0)');var blocked=el.style.length===0;" +
            "el.style.setProperty('color','red');var cssom=el.style.getPropertyValue('color')==='red';" +
            "el.remove();out.cspBlocksInlineStyle=blocked;out.cssomStyle=cssom;}" +
            "catch(e){out.cspBlocksInlineStyle=false;out.cssomStyle=false;}" +
            "try{out.webAnimations=(typeof Element.prototype.animate==='function');}catch(e){out.webAnimations=false;}" +
            "return JSON.stringify(out);})()"
}
