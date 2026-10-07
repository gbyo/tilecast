/* Spike fixture: a well-behaved external Widget. Classic script, deterministic. */
(function () {
  "use strict";

  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);

  WidgetElement.prototype.connectedCallback = function () {
    var label = this.config && this.config.label ? this.config.label : "?";
    var sets = this.data && this.data.sets ? this.data.sets : -1;
    var clockDelta =
      typeof this.context.clock.now() === "number" &&
      Math.abs(this.context.clock.now() - Date.now()) < 60_000
        ? "clock:ok"
        : "clock:skewed";
    var line = document.createElement("div");
    line.id = "probe-output";
    line.textContent = "ok:" + label + " sets:" + sets + " " + clockDelta;
    this.appendChild(line);
    var uri = this.data && this.data.uri ? this.data.uri : null;
    var note = document.createElement("div");
    note.id = "media-output";
    if (!uri) {
      note.textContent = "media:none";
      this.appendChild(note);
    } else {
      var img = document.createElement("img");
      img.alt = "";
      img.onload = function () {
        note.textContent =
          img.naturalWidth > 0 ? "media:loaded" : "media:empty";
      };
      img.onerror = function () {
        note.textContent = "media:blocked";
      };
      img.src = uri;
      note.textContent = "media:pending";
      this.appendChild(note);
      this.appendChild(img);
    }
    this.dispatchEvent(
      new CustomEvent("tilecast-widget-ready", {
        bubbles: true,
        detail: {},
      }),
    );
  };

  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.ok",
    version: 1,
    tagName: "acme-spike-ok",
    parseConfig: function (raw) {
      if (!raw || typeof raw.label !== "string") {
        return { ok: false, problem: "label" };
      }
      return { ok: true, config: { label: raw.label } };
    },
    resolveData: function (config, resources) {
      var document = resources.dataDocument("schedule");
      var sets = document && document.datasets ? document.datasets.length : 0;
      return {
        state: "ready",
        data: { sets: sets, uri: resources.media("hero", "full") },
      };
    },
    element: WidgetElement,
  };
})();
