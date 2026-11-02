/* Conformance fixture: a hostile external Widget (classic script,
 * deterministic). Every probe is wrapped; the rendered line records what
 * the sandbox allowed, for screenshots. The exfil fetch targets a
 * server-controlled canary URL from the Widget config: a contained frame
 * never reaches it, so the test server asserts zero hits. The lifecycle
 * always completes: ready under containment proves isolation did not
 * break execution. Identity: acme.evil/probe v1. */
(function () {
  "use strict";

  var READY_EVENT = "tilecast-widget-ready";
  var REVISION_KEY = "tilecast.widget.inputRevision";

  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);

  WidgetElement.prototype.connectedCallback = function () {
    var verdicts = [];
    function probe(name, fn) {
      try {
        var value = fn();
        verdicts.push(name + ":" + (value ? "allowed" : "empty"));
      } catch (err) {
        verdicts.push(name + ":denied");
      }
    }
    // Parent DOM access must throw (opaque origin, no same-origin).
    probe("parent", function () {
      return window.parent.document === document;
    });
    // Top navigation must not escape the frame.
    probe("topread", function () {
      return window.top.location.href.length > 0;
    });
    // Opaque origins have no storage.
    probe("cookie", function () {
      document.cookie = "x=1";
      return document.cookie.indexOf("x=1") >= 0;
    });
    probe("storage", function () {
      window.localStorage.setItem("x", "1");
      return window.localStorage.getItem("x") === "1";
    });
    // Credential-bearing globals must be absent.
    probe("device", function () {
      return typeof window.__tilecastDeviceCredential !== "undefined";
    });
    var self = this;
    var line = document.createElement("div");
    line.id = "hostile-output";
    function finish(extra) {
      line.textContent = verdicts.join(" ") + " " + extra;
      self.appendChild(line);
      var revision = self[Symbol.for(REVISION_KEY)];
      self.dispatchEvent(
        new CustomEvent(READY_EVENT, { bubbles: true, detail: { revision: revision } }),
      );
    }
    var target = this.data && this.data.exfil ? this.data.exfil : null;
    if (!target) {
      finish("fetch:skipped");
      return;
    }
    try {
      fetch(target, { method: "GET", mode: "no-cors" }).then(
        function () {
          finish("fetch:allowed");
        },
        function () {
          finish("fetch:blocked");
        },
      );
    } catch (err) {
      finish("fetch:blocked");
    }
  };

  globalThis.__tilecastWidgetDefinition = {
    type: "acme.evil.probe",
    version: 1,
    tagName: "acme-evil-probe",
    parseConfig: function (raw) {
      if (!raw || typeof raw.exfil !== "string" || raw.exfil === "") {
        return { ok: false, problem: "exfil" };
      }
      return { ok: true, config: { exfil: raw.exfil } };
    },
    resolveData: function (config) {
      return { state: "ready", data: { exfil: config.exfil } };
    },
    element: WidgetElement,
  };
})();
