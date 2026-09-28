// The one state root (C4) and every path under it. It imports no other server module but gate.ts, so the bundled
// native host can derive its default socket without loading the server.
import os from "node:os";
import path from "node:path";
import { canonicalSocketPath } from "../shared/trusted-path";
import { Gate } from "./gate";

export type Env = Readonly<Record<string, string | undefined>>;

/** The native-host endpoint variable read by the server and exported by host wrappers (D19). */
export const HOST_SOCKET_ENV = "BROWSER_CONTROL_HOST_SOCKET";

export interface StatePaths {
  root: string; registry: string; controllers: string; sockets: string; userSocket: string; hosts: string; extensions: string;
  artifacts: string; userArtifacts: string; locks: string; bin: string;
}

export function homeDirectory(env: Env = process.env): string {
  return env.HOME ?? os.homedir();
}

/** BROWSER_CONTROL_STATE_DIR, default ~/.local/state/browser-control. A relative value fails closed (D8). */
export function statePaths(env: Env = process.env): StatePaths {
  const configured = env.BROWSER_CONTROL_STATE_DIR;
  if (configured && !path.isAbsolute(configured)) throw new Gate("browser-control-invalid-state-dir");
  const root = configured ? path.normalize(configured) : path.join(homeDirectory(env), ".local/state/browser-control");
  return {
    root,
    registry: path.join(root, "pool/registry"),
    controllers: path.join(root, "pool/controllers"),
    sockets: path.join(root, "sockets"),
    // Controller sockets are isolated-N.sock beside it, so the name cannot collide.
    userSocket: path.join(root, "sockets/user.sock"),
    hosts: path.join(root, "hosts"),
    extensions: path.join(root, "extensions"),
    artifacts: path.join(root, "artifacts"),
    userArtifacts: path.join(root, "artifacts/user"),
    locks: path.join(root, "locks"),
    bin: path.join(root, "bin")
  };
}

/**
 * The user route's endpoint: BROWSER_CONTROL_HOST_SOCKET when set, else <state>/sockets/user.sock. The default
 * follows the state root, so installs with different roots never share an endpoint (C4, D1). A socket that is set
 * is given by its canonical path (src/shared/trusted-path.ts), which the wrapper, the snippets and doctor export;
 * the default is already canonical wherever install accepts the state root, which fs-private keeps free of symlinks.
 */
export function userSocket(env: Env = process.env): string {
  const configured = env[HOST_SOCKET_ENV];
  return configured === undefined ? statePaths(env).userSocket : canonicalSocketPath(configured);
}
