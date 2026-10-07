/* Spike fixture: never announces. The parent ready timeout must fire. */
(function () {
  "use strict";
  function WidgetElement() {
    return Reflect.construct(HTMLElement, [], WidgetElement);
  }
  Object.setPrototypeOf(WidgetElement.prototype, HTMLElement.prototype);
  Object.setPrototypeOf(WidgetElement, HTMLElement);
  WidgetElement.prototype.connectedCallback = function () {
    this.textContent = "silent";
  };
  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.silent",
    version: 1,
    tagName: "acme-spike-silent",
    element: WidgetElement,
  };
})();
