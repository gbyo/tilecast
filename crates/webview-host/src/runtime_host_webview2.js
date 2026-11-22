/* WebView2 transport for runtime_host.js: JSON web messaging.
 * Runtime → host: chrome.webview.postMessage with JSON text, read natively
 * with TryGetWebMessageAsString. Host → Runtime: PostWebMessageAsJson, which
 * delivers the parsed value; a string is accepted as JSON text.
 */
(function () {
  if (typeof window.chrome === "undefined" || !window.chrome.webview) {
    return null;
  }
  var webview = window.chrome.webview;
  return {
    post: function (message) {
      webview.postMessage(JSON.stringify(message));
    },
    listen: function (deliver) {
      webview.addEventListener("message", function (event) {
        var message = event.data;
        if (typeof message === "string") {
          try {
            message = JSON.parse(message);
          } catch (error) {
            return;
          }
        }
        deliver(message);
      });
    },
  };
});
