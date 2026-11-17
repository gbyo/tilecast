/* WebKit transport for runtime_host.js: two WKScriptMessageHandlerWithReply
 * channels, both checked natively against the trusted top-level Runtime
 * document before anything is parsed.
 *
 * Runtime → host: tilecastRuntime.postMessage(JSON text). The reply is an
 * acknowledgement only; request answers arrive as "response" messages.
 * Host → Runtime: tilecastHostMessages.postMessage(documentId) is a pull.
 * The host holds the newest pull open and answers it with a JSON array of
 * the messages queued since, in order; the transport delivers them and
 * pulls again. The document id lets the host drop a pull left behind by a
 * replaced document, so queued messages never go to a dead page.
 */
(function () {
  var handlers = window.webkit && window.webkit.messageHandlers;
  var outbound = handlers && handlers.tilecastRuntime;
  var inbound = handlers && handlers.tilecastHostMessages;
  if (!outbound || !inbound) {
    return null;
  }
  var send = outbound.postMessage.bind(outbound);
  var pull = inbound.postMessage.bind(inbound);
  var bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  var documentId = Array.prototype.map
    .call(bytes, function (byte) {
      return (byte < 16 ? "0" : "") + byte.toString(16);
    })
    .join("");
  return {
    post: function (message) {
      send(JSON.stringify(message)).catch(function () {});
    },
    listen: function (deliver) {
      var next = function () {
        pull(documentId).then(
          function (batch) {
            var messages = [];
            try {
              messages = JSON.parse(batch);
            } catch (error) {
              messages = [];
            }
            try {
              for (var i = 0; i < messages.length; i += 1) {
                deliver(messages[i]);
              }
            } finally {
              next();
            }
          },
          function () {
            setTimeout(next, 1000);
          },
        );
      };
      next();
    },
  };
});
