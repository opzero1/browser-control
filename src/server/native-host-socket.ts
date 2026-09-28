// Runs before the bundled native host: without a BROWSER_CONTROL_HOST_SOCKET, the host listens on the server's
// default <state>/sockets/user.sock, not the standalone host's ~/.opzero-chrome/default.sock, so this package's
// host keeps its socket and startup lock under the state root (C4, D1). host.ts itself stays unchanged.
import { isGate } from "./gate";
import { HOST_SOCKET_ENV, statePaths } from "./state-paths";

if (!process.env[HOST_SOCKET_ENV]) {
  try {
    process.env[HOST_SOCKET_ENV] = statePaths(process.env).userSocket;
  } catch (error) {
    if (!isGate(error)) throw error;
    process.stderr.write("Native endpoint setup refused; BROWSER_CONTROL_STATE_DIR must be an absolute path\n");
    process.exit(1);
  }
}
