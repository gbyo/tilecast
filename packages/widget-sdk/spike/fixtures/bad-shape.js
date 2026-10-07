/* Spike fixture: wrong definition type. The bootstrap must refuse it. */
(function () {
  "use strict";
  globalThis.__tilecastWidgetDefinition = {
    type: "acme.spike.other",
    version: 1,
    tagName: "acme-spike-other",
    element: function () {},
  };
})();
