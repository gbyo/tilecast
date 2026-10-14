/** External Player surface ABI 1. Executed only inside the verified frame. */
export const EXTERNAL_PLUGIN_PROTOCOL = "tilecast.plugin.surface/1";
export const EXTERNAL_PLUGIN_FRAME_POLICY =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src 'none'; media-src 'none'; font-src 'none'; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";
export const EXTERNAL_PLUGIN_BUNDLE_PLACEHOLDER =
  "__TILECAST_EXTERNAL_PLUGIN_BUNDLE__";
export const EXTERNAL_PLUGIN_MAX_STATE_BYTES = 16 * 1024;
export const EXTERNAL_PLUGIN_MAX_MESSAGE_BYTES = 32 * 1024;

const bootstrap = String.raw`(function () {
  "use strict";
  var protocol = "tilecast.plugin.surface/1";
  var token = window.location.hash.slice(1);
  var port = null, nonce = null, revision = 0, disposed = false;
  var definition = null;
  var context = { wallClockOffsetMs: 0, reducedMotion: true, theme: "dark", locale: "en", awake: false };
  function post(kind, value) {
    if (disposed || !port) return;
    port.postMessage({ protocol: protocol, nonce: nonce, revision: revision, kind: kind, value: value });
  }
  var bridge = {
    now: function () { return Date.now() + context.wallClockOffsetMs; },
    claim: function (claim) { post("claim", claim); }
  };
  function sizeOK(value) {
    try { return new TextEncoder().encode(JSON.stringify(value)).length <= 32768; }
    catch (error) { return false; }
  }
  function validRevision(value) { return Number.isSafeInteger(value) && value >= 1; }
  function apply(message) {
    if (!message || message.protocol !== protocol || message.nonce !== nonce || disposed || !sizeOK(message)) return;
    if (message.kind === "dispose") {
      disposed = true;
      try { if (definition && typeof definition.dispose === "function") definition.dispose(); } catch (error) {}
      port.close(); document.body.replaceChildren(); return;
    }
    if (!validRevision(message.revision) || message.revision < revision) return;
    if (message.kind === "state") {
      if (message.revision <= revision) return;
      revision = message.revision;
      context = message.context;
      try { definition.update(message.state, context, bridge); }
      catch (error) { post("claim", null); }
    } else if (message.kind === "grant" && message.revision === revision) {
      try { if (typeof definition.grant === "function") definition.grant(message.value, context, bridge); }
      catch (error) { post("claim", null); }
    }
  }
  function attach(event) {
    var message = event.data;
    if (disposed || port || event.source !== window.parent || !message || message.protocol !== protocol || message.kind !== "init") return;
    if (message.helloToken !== token || !/^[a-f0-9]{32}$/.test(message.nonce) || !sizeOK(message) || !validRevision(message.revision)) return;
    var offered = event.ports && event.ports.length === 1 && event.ports[0];
    if (!offered) return;
    definition = window.__tilecastExternalPlugin;
    if (!definition || typeof definition.update !== "function") { offered.close(); disposed = true; return; }
    nonce = message.nonce; port = offered;
    window.removeEventListener("message", attach);
    port.onmessage = function (event) { apply(event.data); };
    port.start(); message.kind = "state"; apply(message);
  }
  window.addEventListener("message", attach);
  if (/^[a-f0-9]{32}$/.test(token)) window.parent.postMessage({ protocol: protocol, kind: "frame-hello", helloToken: token }, "*");
})();`;

export function escapeExternalPluginScript(bundle: string): string {
  return bundle.replace(/<\/script/gi, "<\\/script");
}

/** The host response supplies the authoritative sandbox policy. */
export function buildExternalPluginFrame(bundle: string): string {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${EXTERNAL_PLUGIN_FRAME_POLICY}"><style>html,body{margin:0;padding:0;width:100%;height:100%;overflow:hidden;background:transparent;color:white}*{box-sizing:border-box}</style></head><body><script>${bootstrap}</script><script>${escapeExternalPluginScript(bundle)}</script></body></html>`;
}
