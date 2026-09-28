// The roots the server and its commands take from the environment, arguments or options: the state root, the
// user route's artifact root and the native host socket. Each goes through the trusted-path rule
// (src/shared/trusted-path.ts) where it enters, and is used from then on by its canonical path; a root that fails
// is refused with a fixed message that names it and the directory at fault.
import { checkedSocketPath, trustedPath, type MissingDirectory, type TrustedDirectory, type UntrustedPath } from "../shared/trusted-path";
import { HOST_SOCKET_ENV, statePaths, type Env } from "./state-paths";

export type RootKind = "state directory" | "artifact directory" | "native host socket" | "skills directory" | "temporary directory";

const RULE = "must be a directory owned by you or root that only its owner can write to, unless it has the sticky bit";

/** A root that another user could change, or that could not be checked (`code`). */
export class UnsafeRoot extends Error {
  readonly code = "browser-control-unsafe-root";
  constructor(readonly kind: RootKind, readonly given: string, readonly unsafe: string, readonly errno?: string) {
    super(errno === undefined ? `Refusing the ${kind} ${given}: ${unsafe} ${RULE}.` : `Refusing the ${kind} ${given}: it could not be checked (${errno}).`);
    this.name = "UnsafeRoot";
  }
}

function codeOf(error: unknown): string | undefined {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return typeof code === "string" ? code : undefined;
}

/**
 * The canonical path of the directory `given`, once its existing part passed the rule; a missing rest is kept as
 * given and is made later only inside checked directories. Throws UnsafeRoot.
 */
export function trustedRoot(kind: RootKind, given: string): string {
  let checked: TrustedDirectory | MissingDirectory | UntrustedPath;
  try {
    checked = trustedPath(given, { missing: true });
  } catch (error) {
    const code = codeOf(error);
    if (code === undefined) throw error;
    throw new UnsafeRoot(kind, given, given, code);
  }
  if ("unsafe" in checked) throw new UnsafeRoot(kind, given, checked.unsafe);
  return checked.path;
}

/**
 * `env` with the state root, the native host socket and, with `artifacts`, FAST_CHROME_ARTIFACT_ROOT by their
 * canonical paths; the same object when none changes. A relative state root is the Gate statePaths raises; any
 * root that fails the rule throws UnsafeRoot.
 */
export function trustedEnv(env: Env, options: { artifacts?: boolean } = {}): Env {
  const changes: Record<string, string> = {};
  const root = statePaths(env).root;
  const state = trustedRoot("state directory", root);
  if (state !== root) changes.BROWSER_CONTROL_STATE_DIR = state;
  const socket = env[HOST_SOCKET_ENV];
  if (socket) {
    const checked = checkedSocketPath(socket);
    if (typeof checked !== "string") throw new UnsafeRoot("native host socket", socket, checked.unsafe);
    if (checked !== socket) changes[HOST_SOCKET_ENV] = checked;
  }
  const artifacts = env.FAST_CHROME_ARTIFACT_ROOT;
  if (options.artifacts && artifacts) {
    const canonical = trustedRoot("artifact directory", artifacts);
    if (canonical !== artifacts) changes.FAST_CHROME_ARTIFACT_ROOT = canonical;
  }
  return Object.keys(changes).length ? { ...env, ...changes } : env;
}
