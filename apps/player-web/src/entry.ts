import { takeRecoverySecret } from "./bootstrap";
// This tiny entry runs before the Host imports, opens storage or boots Runtime.
let recovery = takeRecoverySecret(location, history);
void import("./application").then(({ start }) => {
  let secret = recovery;
  recovery = null;
  void start(secret).catch(() => {
    const message = document.createElement("p");
    message.textContent =
      "Browser Player could not start. Check the HTTPS certificate and browser storage permissions, then reload.";
    document.body.replaceChildren(message);
  });
  secret = null;
});
