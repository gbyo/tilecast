/* Tilecast Windows host bootstrap: the one Tilecast-owned script injected
 * before Runtime scripts execute. It exposes exactly one object,
 * globalThis.tilecastRuntimeHost, implementing TilecastRuntimeHostV1 over
 * WebView2 JSON web messaging. There is no generic invoke and no host
 * object: every capability is a named, typed member below.
 *
 * __TILECAST_HOST_INFO__ and __TILECAST_HOST_CAPABILITIES__ are replaced by
 * the native host with JSON before injection.
 */
(function () {
  "use strict";
  if (typeof window.chrome === "undefined" || !window.chrome.webview) {
    return;
  }
  if (globalThis.tilecastRuntimeHost) {
    return;
  }
  var webview = window.chrome.webview;
  var post = function (message) {
    webview.postMessage(JSON.stringify(message));
  };

  var listeners = new Set();
  var lastPresentation = null;
  var lastPlugins = null;
  function emit(message) {
    if (message && message.type === "presentation") lastPresentation = message;
    if (message && message.type === "plugins") lastPlugins = message;
    listeners.forEach(function (listener) {
      try {
        listener(message);
      } catch (error) {
        console.error("tilecast host listener failed", error);
      }
    });
  }

  var pending = new Map();
  var nextId = 1;
  webview.addEventListener("message", function (event) {
    var message = null;
    try {
      message = JSON.parse(event.data);
    } catch (error) {
      return;
    }
    if (
      message &&
      message.kind === "response" &&
      typeof message.id === "string"
    ) {
      var waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        if (Object.prototype.hasOwnProperty.call(message, "error")) {
          waiter.reject(new Error(String(message.error || "request failed")));
        } else {
          waiter.resolve(message.result);
        }
      }
      return;
    }
    emit(message);
  });

  function request(method, params) {
    return new Promise(function (resolve, reject) {
      var id = String(nextId);
      nextId += 1;
      pending.set(id, { resolve: resolve, reject: reject });
      post({ kind: "request", id: id, method: method, params: params || {} });
    });
  }

  var text = function (value, max) {
    return String(value === undefined || value === null ? "" : value).slice(
      0,
      max,
    );
  };

  var capabilities = __TILECAST_HOST_CAPABILITIES__;
  var host = {
    contractVersion: 1,
    info: __TILECAST_HOST_INFO__,
    capabilities: capabilities,
    subscribe: function (listener) {
      listeners.add(listener);
      if (lastPresentation) listener(lastPresentation);
      if (lastPlugins) listener(lastPlugins);
      return function () {
        listeners.delete(listener);
      };
    },
    ready: function (ready) {
      post({
        kind: "ready",
        contractVersion: Number(ready.contractVersion),
        runtimeVersion: text(ready.runtimeVersion, 32),
        support: ready.support === undefined ? null : ready.support,
      });
    },
    presentationResult: function (result) {
      post({
        kind: "presentation-result",
        activation: result.activation === undefined ? null : result.activation,
        outcome: result.outcome,
        code: result.code === undefined ? null : text(result.code, 64),
        message:
          result.message === undefined ? null : text(result.message, 240),
      });
    },
    reportEvidence: function (report) {
      post({
        kind: "evidence",
        activation: report.activation === undefined ? null : report.activation,
        itemId:
          report.itemId === undefined || report.itemId === null
            ? null
            : text(report.itemId, 160),
        evidence: report.kind,
        zoneId: report.zoneId === undefined ? null : text(report.zoneId, 160),
      });
    },
    reportPlaybackError: function (report) {
      post({
        kind: "playback-error",
        activation: report.activation === undefined ? null : report.activation,
        itemId:
          report.itemId === undefined || report.itemId === null
            ? null
            : text(report.itemId, 160),
        message: text(report.message, 240),
      });
    },
  };
  if (capabilities && capabilities.setup) {
    host.setup = {
      submitServerUrl: function (url) {
        return request("setup.submitServerUrl", { url: text(url, 512) });
      },
    };
  }
  if (capabilities && capabilities.discovery) {
    host.discovery = {
      list: function () {
        return request("discovery.list", {});
      },
    };
  }
  if (capabilities && capabilities.remoteWeb === "host-view") {
    // Fire-and-forget members carry an id (the bridge requires one) but
    // leave no waiter: the native side never answers them.
    var notify = function (method, params) {
      var id = String(nextId);
      nextId += 1;
      post({ kind: "request", id: id, method: method, params: params || {} });
    };
    host.remoteWeb = {
      reportRecovered: function () {
        notify("remoteWeb.reportRecovered", {});
      },
      create: function (spec) {
        return request("remoteWeb.create", spec || {});
      },
      updateViewport: function (surfaceId, viewport) {
        notify("remoteWeb.updateViewport", {
          surfaceId: text(surfaceId, 48),
          viewport: viewport || {},
        });
      },
      setVisible: function (surfaceId, visible) {
        notify("remoteWeb.setVisible", {
          surfaceId: text(surfaceId, 48),
          visible: !!visible,
        });
      },
      setMuted: function (surfaceId, muted) {
        notify("remoteWeb.setMuted", {
          surfaceId: text(surfaceId, 48),
          muted: !!muted,
        });
      },
      reload: function (surfaceId) {
        notify("remoteWeb.reload", { surfaceId: text(surfaceId, 48) });
      },
      destroy: function (surfaceId) {
        notify("remoteWeb.destroy", { surfaceId: text(surfaceId, 48) });
      },
    };
  }

  Object.freeze(host);
  Object.defineProperty(globalThis, "tilecastRuntimeHost", {
    value: host,
    writable: false,
    configurable: false,
  });
})();
