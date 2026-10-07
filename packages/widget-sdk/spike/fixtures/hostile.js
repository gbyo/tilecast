/* Spike fixture: a hostile external Widget. Every probe is wrapped; the
 * rendered line records what the sandbox allowed. The parent can only see
 * this through a screenshot: the bridge carries lifecycle states, never
 * probe output. */
(function () {
  "use strict";

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
    var line = document.createElement("div");
    line.id = "hostile-output";
    // fetch is async; the ready event waits for it so one line holds all.
    var self = this;
    function finish(extra) {
      line.textContent = verdicts.join(" ") + " " + extra;
      self.appendChild(line);
      self.dispatchEvent(
        new CustomEvent("tilecast-widget-ready", {
          bubbles: true,
          detail: {},
        }),
      );
    }
    try {
      fetch("https://example.invalid/probe", { method: "GET" }).then(
        function () {
          finish("fetch:allowed");
        },
        function () {
          // Rejected: either no network or no route. The spike doc
          // records which by re-running with connect-src in place.
          finish("fetch:rejected");
        },
      );
    } catch (err) {
      finish("fetch:denied");
    }
    setTimeout(function () {
      if (!line.isConnected) finish("fetch:timeout");
    }, 3000);
  };

  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.hostile",
    version: 1,
    tagName: "acme-spike-hostile",
    element: WidgetElement,
  };
})();
