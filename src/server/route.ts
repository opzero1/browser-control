// Where a new tab goes: the caller's browser lease, or else the user's Chrome. Resolved only to open, claim or
// list tabs and for status; tab tools use the tab's own binding. The fixed numbered route is not ported (C8).
import { userArtifactRoot, userSocket, type Env } from "./config";
import { Gate } from "./gate";
import { leaseFor, siteKey, validOwner, type LeaseMode, type PoolContext } from "./pool/registry";

export interface Route {
  readonly kind: "lease" | "user";
  readonly socket: string;
  readonly artifactRoot: string | null;
  /** The user route's default artifact root, created 0700 on first use (D2). */
  readonly createArtifactRoot: boolean;
  readonly controllerId: string | null;
  readonly leaseId: string | null;
  readonly mode: LeaseMode | null;
  readonly sites: readonly string[];
}

/**
 * Chrome tab IDs are unique only within one Chrome, and one process can hold tabs from the user's Chrome and
 * several leased controllers, so a lease route's tab handles name their controller. User-route handles stay
 * bare Chrome tab IDs.
 */
export function routePrefix(target: Route): string {
  return target.kind === "lease" ? `${target.controllerId}:` : "";
}

/** The Chrome tab ID behind one of this route's handles, or null for another route's handle. */
export function chromeId(target: Route, tabId: unknown): string | null {
  if (typeof tabId !== "string") return null;
  const prefix = routePrefix(target);
  if (!tabId.startsWith(prefix)) return null;
  const rest = tabId.slice(prefix.length);
  return /^[1-9][0-9]{0,15}$/.test(rest) ? rest : null;
}

/** A tab URL's cookie site, or null when the URL has no valid host. */
export function siteOf(url: unknown): string | null {
  try {
    return siteKey(url);
  } catch (error) {
    if (!(error instanceof Gate) || error.code !== "fast-chrome-site-invalid") throw error;
    return null;
  }
}

/** A lease route shows and claims only tabs on its own sites. */
export function routeLists(target: Route, url: unknown): boolean {
  if (target.kind !== "lease") return true;
  const site = siteOf(url);
  return site !== null && target.sites.includes(site);
}

export function userRoute(env: Env): Route {
  const artifacts = userArtifactRoot(env);
  return {
    kind: "user", socket: userSocket(env), artifactRoot: artifacts.root, createArtifactRoot: !artifacts.explicit,
    controllerId: null, leaseId: null, mode: null, sites: []
  };
}

/** The session's lease when it holds one, else the user's Chrome. Only pool-shaped session IDs hold a lease. */
export async function resolveRoute(session: string, env: Env, pool: () => PoolContext): Promise<Route> {
  let valid = true;
  try {
    validOwner(session);
  } catch (error) {
    if (!(error instanceof Gate)) throw error;
    valid = false;
  }
  const lease = valid ? await leaseFor(session, pool()) : null;
  if (lease !== null) {
    return {
      kind: "lease", socket: lease.socket, artifactRoot: lease.artifacts, createArtifactRoot: false,
      controllerId: lease.controller_id, leaseId: lease.lease_id, mode: lease.mode, sites: [...lease.sites]
    };
  }
  return userRoute(env);
}
