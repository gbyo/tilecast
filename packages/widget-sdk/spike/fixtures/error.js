/* Spike fixture: announces an error with an unbounded code. */
(function () {
  "use strict";
  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);
  WidgetElement.prototype.connectedCallback = function () {
    var revision = this[Symbol.for("tilecast.widget.inputRevision")];
    this.dispatchEvent(
      new CustomEvent("tilecast-widget-error", {
        bubbles: true,
        detail: { code: "<img src=x onerror=alert(1)>", revision: revision },
      }),
    );
  };
  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.error",
    version: 1,
    tagName: "acme-spike-error",
    element: WidgetElement,
  };
})();
