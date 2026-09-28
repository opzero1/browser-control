// Managed tabs and their registry. Every lookup that takes a tab's busy flag is one synchronous step, so a
// call keeps the exact Tab object it locked (this replaces Python's REGISTRY lock and HELD ContextVar).
import { Gate } from "./gate";
import type { HostConnection } from "./host-connection";
import type { Page } from "./page";
import type { Recording } from "./captures";
import type { JsonObject } from "./pyjson";
import type { LeaseMode, Pin } from "./pool/registry";
import { BusyFlag } from "./runtime/busy";

/** Tab methods that change the page or carry private input; Tab.call refuses them once shutdown begins. */
export const INPUT_METHODS: ReadonlySet<string> = new Set(["navigatePage", "actPage", "uploadFile", "privateFill", "submitPrivate"]);

export interface TabBinding {
  controllerId?: string | null;
  leaseId?: string | null;
  mode?: LeaseMode | null;
  site?: string | null;
  artifactRoot?: string | null;
  /** The artifact root is the default user root, created 0700 on first use (D2). */
  createArtifactRoot?: boolean;
  /** The route's handle prefix; see Route.prefix. */
  prefix?: string;
}

export class Tab {
  snapshot: [string, string] | null = null;
  page: Page | null = null;
  recording: Recording | null = null;
  releaseAttempted = false;
  operation = new BusyFlag();
  controlsOnly = false;
  privateAttempts = new Set<string>();
  privateIdentity: readonly [string, string] | null = null;
  groupTitle: string | null = null;
  controllerPin: Pin | null = null;
  // Fixed at open or claim; later tab tools never resolve the route again.
  readonly controllerId: string | null;
  readonly leaseId: string | null;
  readonly mode: LeaseMode | null;
  readonly site: string | null;
  readonly artifactRoot: string | null;
  readonly createArtifactRoot: boolean;
  readonly prefix: string;

  constructor(readonly owner: string, readonly connection: HostConnection, readonly id: number, readonly origin: string,
    public created: boolean, private readonly refuseInput: () => void = () => undefined, binding: TabBinding = {}) {
    this.controllerId = binding.controllerId ?? null;
    this.leaseId = binding.leaseId ?? null;
    this.mode = binding.mode ?? null;
    this.site = binding.site ?? null;
    this.artifactRoot = binding.artifactRoot ?? null;
    this.createArtifactRoot = binding.createArtifactRoot ?? false;
    this.prefix = binding.prefix ?? "";
  }

  /** The adapter's handle for this tab: its registry key and every returned tab_id. */
  get key(): string {
    return `${this.prefix}${this.id}`;
  }

  /** Once shutdown begins, input is refused here, just before it would be sent. Reads and cleanup still go out. */
  call(method: string, params: JsonObject = {}): Promise<unknown> {
    if (INPUT_METHODS.has(method)) this.refuseInput();
    return this.connection.call(method, { tabId: this.id, ...params });
  }
}

/** The process's managed tabs by handle. No method awaits, so each is atomic on the event loop. */
export class TabRegistry {
  readonly tabs = new Map<string, Tab>();

  constructor(private readonly refuseInput: () => void = () => undefined) {}

  get(key: string): Tab | undefined {
    return this.tabs.get(key);
  }

  values(): Tab[] {
    return [...this.tabs.values()];
  }

  /**
   * Resolve a managed tab and take its busy flag in one step. With claimable, an unmanaged handle returns null
   * instead of failing, and a terminal tab is refused.
   */
  hold(tabId: unknown, session: string, claimable = false): Tab | null {
    const tab = typeof tabId === "string" ? this.tabs.get(tabId) : undefined;
    if (tab === undefined && claimable) return null;
    if (tab === undefined || tab.owner !== session) throw new Gate("fast-chrome-tab-not-owned");
    if (claimable && (tab.releaseAttempted || !tab.connection.alive)) throw new Gate("fast-chrome-tab-terminal");
    if (!tab.operation.tryAcquire()) throw new Gate("fast-chrome-tab-busy");
    return tab;
  }

  /** Before a new tab's attach and bind: refused once shutdown begins or when its handle is taken. */
  checkFree(tab: Tab): void {
    this.refuseInput();
    if (this.tabs.has(tab.key)) throw new Gate("fast-chrome-tab-already-managed");
  }

  /** Publish a new tab under its handle; cleanup takes its list of tabs once shutdown begins, so it is refused then. */
  publish(tab: Tab): void {
    this.checkFree(tab);
    this.tabs.set(tab.key, tab);
  }

  /** Remove the handle only while it still names this exact tab. */
  remove(tab: Tab): void {
    if (this.tabs.get(tab.key) === tab) this.tabs.delete(tab.key);
  }

  /** failed_setup: keep an unconfirmed tab visible unless another tab took its handle. */
  retain(tab: Tab): void {
    const current = this.tabs.get(tab.key);
    if (current === undefined || current === tab) this.tabs.set(tab.key, tab);
  }

  /** Take every tab for cleanup and clear the registry. */
  drain(): Tab[] {
    const tabs = this.values();
    this.tabs.clear();
    return tabs;
  }
}
