/* Conformance fixture: a well-behaved external Widget (classic script,
 * deterministic). The bundle gates its ready signal on every input the
 * host must deliver: compiled configuration, prepared Data Source
 * documents, a granted media URI whose bytes load, and a sane projected
 * clock. A host that delivers anything wrong gets an error, never a
 * silent half-render. Identity: acme.athletics/scoreboard v2. */
(function () {
  "use strict";

  var READY_EVENT = "tilecast-widget-ready";
  var ERROR_EVENT = "tilecast-widget-error";
  var REVISION_KEY = "tilecast.widget.inputRevision";

  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);

  WidgetElement.prototype.connectedCallback = function () {
    var self = this;
    var revision = this[Symbol.for(REVISION_KEY)];
    function ready() {
      self.dispatchEvent(
        new CustomEvent(READY_EVENT, { bubbles: true, detail: { revision: revision } }),
      );
    }
    function fail(code) {
      self.dispatchEvent(
        new CustomEvent(ERROR_EVENT, { bubbles: true, detail: { revision: revision, code: code } }),
      );
    }
    // Host-projected clock: the frame and the host share one device
    // clock, so a large skew means the context never arrived.
    var skewed =
      !this.context ||
      !this.context.clock ||
      typeof this.context.clock.now() !== "number" ||
      Math.abs(this.context.clock.now() - Date.now()) >= 60_000;
    if (skewed) {
      fail("widget_clock_skewed");
      return;
    }
    var uri = this.data && this.data.uri ? this.data.uri : null;
    if (!uri) {
      fail("widget_media_missing");
      return;
    }
    var line = document.createElement("div");
    line.id = "probe-output";
    line.textContent = "fixture:" + (this.config && this.config.label ? this.config.label : "?");
    this.appendChild(line);
    // The grant URI must load through the host's confined media path.
    // An <img> the sandbox cannot load fails the mount visibly.
    var img = document.createElement("img");
    img.alt = "";
    img.onload = function () {
      if (img.naturalWidth > 0) {
        ready();
      } else {
        fail("widget_media_empty");
      }
    };
    img.onerror = function () {
      fail("widget_media_blocked");
    };
    img.src = uri;
    this.appendChild(img);
  };

  globalThis.__tilecastWidgetDefinition = {
    type: "acme.athletics.scoreboard",
    version: 2,
    tagName: "acme-scoreboard",
    parseConfig: function (raw) {
      if (!raw || typeof raw.label !== "string" || raw.label === "") {
        return { ok: false, problem: "label" };
      }
      // Manifest identities ride the server-compiled config, so one
      // static bundle serves every test manifest.
      if (typeof raw.mediaAssetId !== "string" || typeof raw.mediaVariantId !== "string") {
        return { ok: false, problem: "media" };
      }
      if (typeof raw.documentId !== "string" || raw.documentId === "") {
        return { ok: false, problem: "document" };
      }
      return { ok: true, config: { label: raw.label, mediaAssetId: raw.mediaAssetId, mediaVariantId: raw.mediaVariantId, documentId: raw.documentId } };
    },
    resolveData: function (config, resources) {
      var document = resources.dataDocument(config.documentId);
      var sets = document && document.datasets ? document.datasets.length : 0;
      if (sets < 1) {
        return { state: "error", code: "widget_data_missing" };
      }
      var uri = resources.media(config.mediaAssetId, config.mediaVariantId);
      if (!uri) {
        return { state: "error", code: "widget_media_missing" };
      }
      return { state: "ready", data: { sets: sets, uri: uri } };
    },
    element: WidgetElement,
  };
})();
