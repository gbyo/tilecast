/* Spike fixture: resolves empty. */
(function () {
  "use strict";
  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);
  WidgetElement.prototype.connectedCallback = function () {
    this.textContent = this.empty || "";
    var revision = this[Symbol.for("tilecast.widget.inputRevision")];
    this.dispatchEvent(
      new CustomEvent("tilecast-widget-empty", {
        bubbles: true,
        detail: { reason: this.empty, revision: revision },
      }),
    );
  };
  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.empty",
    version: 1,
    tagName: "acme-spike-empty",
    resolveData: function () {
      return { state: "empty", reason: "nothing_today" };
    },
    element: WidgetElement,
  };
})();
