import { takeRecoverySecret } from "./bootstrap";
// This tiny entry runs before the Host imports, opens storage or boots Runtime.
let recovery = takeRecoverySecret(location, history);
void import("./application").then(({ start }) => {
  let secret = recovery;
  recovery = null;
  void start(secret);
  secret = null;
});
