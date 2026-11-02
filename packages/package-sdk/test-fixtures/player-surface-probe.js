/* Shared surface ABI fixture. Green means the private channel supplied
 * state, clock, and a grant while DOM and native host access stayed blocked. */
(function () {
  "use strict";
  var shell = document.createElement("div");
  shell.style.cssText = "width:240px;height:120px;background:#ff0000";
  document.body.appendChild(shell);
  var inputs = false,
    isolated = false,
    state = null,
    timer = null,
    baseline = false;
  try {
    void parent.document.body;
  } catch (error) {
    isolated = true;
  }
  isolated =
    isolated &&
    !window.TilecastRuntimeHostV1 &&
    !window.__tilecastHost &&
    !(
      window.webkit &&
      window.webkit.messageHandlers &&
      window.webkit.messageHandlers.tilecast
    );
  window.__tilecastExternalPlugin = {
    update: function (value, context, bridge) {
      state = value;
      if (value.color === "#00ff00") baseline = true;
      inputs =
        baseline &&
        isolated &&
        context.awake === true &&
        context.theme === "dark" &&
        typeof context.reducedMotion === "boolean" &&
        Math.abs(bridge.now() - Date.now()) < 10000;
      bridge.claim(
        value.visible === false
          ? null
          : {
              slot: value.slot || "corner.bottom-left",
              priority: 0,
            },
      );
      if (!timer && value.navigationProbe) {
        timer = setTimeout(function () {
          // Both destinations are native-allowlisted in isolation. The host
          // must distinguish an existing untrusted document from first load.
          try {
            location.href = "tilecast://runtime/index.html";
          } catch (error) {}
          setTimeout(function () {
            try {
              location.reload();
            } catch (error) {}
          }, 300);
        }, 300);
      }
    },
    grant: function (value) {
      shell.style.background = inputs && value.shown ? state.color : "#ff0000";
    },
    dispose: function () {
      clearTimeout(timer);
      shell.remove();
    },
  };
})();
