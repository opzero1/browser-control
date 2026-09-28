// The private transfer (private_input.py): bind an owned tab's exact URL and document, read one field through
// the private source, and send it once with privateFill, then submit the observed sign-in once.
//
// The Direct account-pool lease is gone (C6, Q2): no lease_id and no pool-account branch. Tab ownership stays
// the session guard, checked here as well as by the server before any page call or vault read.
import type { Env } from "../config";
import { allowLoopback } from "../config";
import { Gate } from "../gate";
import type { HostConnection } from "../host-connection";
import type { JsonObject } from "../pyjson";
import { pyIsSpace, pyLen } from "../pystr";
import { monotonic, sleep } from "../time";
import { urlsplit } from "../urlsplit";
import type { VaultField } from "./onepassword";

export const SUBMIT_MARGIN_SECONDS = 5;
export const LEGACY_SUBMIT_LIFETIME_MS = 30000;
const MAX_SUBMIT_LIFETIME_MS = 120000;
const OTP_WAIT_SECONDS = 10;
const OTP_POLL_SECONDS = 0.1;
const MAX_VALUE_LENGTH = 16384;
const MAX_SELECTOR_LENGTH = 1024;
const MAX_BINDING_LENGTH = 200;
const RETRY_CODES: ReadonlySet<string> = new Set(["browser-control-private-fields-unavailable", "browser-control-page-not-ready"]);

export interface PrivateTab {
  readonly id: number;
  readonly origin: string;
  readonly owner: string;
  readonly connection: HostConnection;
  snapshot: readonly [string, string] | null;
  page: { actions: readonly { id: string; kind: string }[] } | null;
  recording: unknown | null;
  /** documentId + "\u0000" + field for each private step already attempted in that document. */
  privateAttempts: Set<string>;
  privateIdentity: readonly [string, string] | null;
  call(method: string, params?: JsonObject): Promise<unknown>;
}

/** The public request. `session` is the caller's identity; it must own the tab. */
export interface PasteRequest { session: string; expectedUrl: string; email: unknown; field: unknown; selector: unknown; usernameSelector: unknown; snapshotId: unknown; submitActionId: unknown }

export type PrivateSource = (email: string, field: VaultField) => Promise<string>;
export type PasteResult = Record<string, unknown>;

type Observed = JsonObject & { token: string; documentId: string };

function isDict(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truthy(value: unknown): boolean {
  if (value === null || value === undefined || value === false || value === 0 || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isDict(value)) return Object.keys(value).length > 0;
  return true;
}

/** Python ==, for a host row id against the tab's int id (True == 1). */
function sameId(value: unknown, id: number): boolean {
  return typeof value === "boolean" ? Number(value) === id : value === id;
}

/** re.fullmatch(r"[^\s@]{1,200}@[^\s@]{1,200}", email), with Python's Unicode \s. */
function validEmail(email: string): boolean {
  const points = [...email];
  const at = points.indexOf("@");
  if (at < 0 || points.lastIndexOf("@") !== at) return false;
  const domain = points.length - at - 1;
  return at >= 1 && at <= 200 && domain >= 1 && domain <= 200 && !points.some(pyIsSpace);
}

function key(documentId: string, field: string): string {
  return `${documentId}\u0000${field}`;
}

/** The tab's host row still has the exact expected URL. */
export async function checkUrl(tab: PrivateTab, expectedUrl: string): Promise<void> {
  const rows = await tab.connection.call("getTabs");
  if (!Array.isArray(rows)) throw new Gate("fast-chrome-private-target-unavailable");
  const matches = rows.filter((row) => isDict(row) && sameId(row.id, tab.id));
  if (matches.length !== 1 || (matches[0] as Record<string, unknown>).url !== expectedUrl) throw new Gate("fast-chrome-private-url-changed");
}

/**
 * Bind the private fields to the exact URL and document. With `wait`, a missing field is polled for 10 s;
 * refuseInput runs before each retry, so shutdown ends the wait before another read.
 */
export async function observeFields(tab: PrivateTab, expectedUrl: string, selectors: string[], wait: boolean, refuseInput: () => void, env: Env = process.env): Promise<Observed> {
  const deadline = monotonic() + (wait ? OTP_WAIT_SECONDS : 0);
  const url = urlsplit(expectedUrl);
  const loopback = allowLoopback(env) && url.scheme === "http" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  let result: unknown;
  while (true) {
    try {
      result = await tab.call("observeDocument", { expectedOrigin: tab.origin, expectedUrl, selectors, allowInsecureLoopback: loopback });
      break;
    } catch (error) {
      if (!(error instanceof Gate) || !RETRY_CODES.has(error.code) || monotonic() >= deadline) throw error;
      await sleep(OTP_POLL_SECONDS * 1000);
      refuseInput();
      await checkUrl(tab, expectedUrl);
    }
  }
  const bound = (value: unknown) => typeof value === "string" && pyLen(value) > 0 && pyLen(value) <= MAX_BINDING_LENGTH;
  if (!isDict(result) || result.origin !== tab.origin || result.url !== expectedUrl || !bound(result.token) || !bound(result.documentId)) {
    throw new Gate("fast-chrome-private-url-binding-unavailable");
  }
  return result as Observed;
}

/** Bind the observed submit action before the vault read; the capability expires SUBMIT_MARGIN_SECONDS early. */
export async function prepareSubmit(tab: PrivateTab, extensionSnapshot: string, actionId: string, documentId: string): Promise<[Record<string, unknown>, number]> {
  const started = monotonic();
  const prepared = await tab.call("preparePrivateSubmit", { snapshot: extensionSnapshot, actionId });
  const lifetime = isDict(prepared) ? (Object.prototype.hasOwnProperty.call(prepared, "expiresInMs") ? prepared.expiresInMs : LEGACY_SUBMIT_LIFETIME_MS) : null;
  if (!isDict(prepared) || prepared.status !== "prepared" || prepared.documentId !== documentId || typeof prepared.submitToken !== "string"
    || typeof lifetime !== "number" || !Number.isInteger(lifetime) || !(lifetime > 0 && lifetime <= MAX_SUBMIT_LIFETIME_MS)) {
    throw new Gate("fast-chrome-private-submit-not-prepared");
  }
  return [prepared, started + lifetime / 1000 - SUBMIT_MARGIN_SECONDS];
}

/**
 * Transfer one private field into the owned tab. refuseInput throws once no further private input may be
 * sent. It runs before the submit is prepared, before each retry of the OTP field wait, as soon as the vault
 * read returns, and just before each private send. Results are fixed statuses; the value never leaves this
 * function except inside the single privateFill request.
 */
export async function paste(tab: PrivateTab, request: PasteRequest, source: PrivateSource, refuseInput: () => void, env: Env = process.env): Promise<PasteResult> {
  const { expectedUrl, email, field, selector, usernameSelector, snapshotId, submitActionId } = request;
  if (typeof request.session !== "string" || !request.session || request.session !== tab.owner) throw new Gate("fast-chrome-tab-not-owned");
  if ((field !== "password" && field !== "one-time password")
    || typeof email !== "string" || !validEmail(email)
    || typeof selector !== "string" || !(pyLen(selector) > 0 && pyLen(selector) <= MAX_SELECTOR_LENGTH)) {
    throw new Gate("fast-chrome-invalid-private-request");
  }
  // A recording is an object, which Python always treats as true, whatever fields it has.
  if (tab.recording !== null && tab.recording !== undefined) throw new Gate("fast-chrome-stop-recording-first");
  if (field === "password") {
    if (typeof usernameSelector !== "string" || !(pyLen(usernameSelector) > 0 && pyLen(usernameSelector) <= MAX_SELECTOR_LENGTH)
      || usernameSelector === selector || !truthy(snapshotId) || !truthy(submitActionId)) {
      throw new Gate("fast-chrome-password-submit-required");
    }
    if (tab.snapshot === null || snapshotId !== tab.snapshot[0]) throw new Gate("fast-chrome-snapshot-consumed-or-expired");
    const action = (tab.page as NonNullable<PrivateTab["page"]>).actions.find((item) => item.id === submitActionId);
    if (action === undefined || action.kind !== "click") throw new Gate("fast-chrome-action-unavailable");
  } else if ([usernameSelector, snapshotId, submitActionId].some((value) => value !== null && value !== undefined)) {
    throw new Gate("fast-chrome-otp-auto-submits");
  }

  await checkUrl(tab, expectedUrl);
  const fields = field === "password" ? [usernameSelector as string, selector] : [selector];
  const observed = await observeFields(tab, expectedUrl, fields, field === "one-time password", refuseInput, env);
  const attempt = key(observed.documentId, field);
  if (tab.privateAttempts.has(attempt)) throw new Gate("fast-chrome-private-step-already-attempted");
  if (field === "one-time password" && (tab.privateIdentity === null || tab.privateIdentity[0] !== email || tab.privateIdentity[1] !== observed.documentId)) {
    throw new Gate("fast-chrome-private-account-not-bound");
  }
  let prepared: Record<string, unknown> | null = null;
  let submitDeadline = 0;
  if (field === "password") {
    refuseInput(); // before preparePrivateSubmit: a refusal sends and consumes nothing
    const extensionSnapshot = (tab.snapshot as readonly [string, string])[1];
    tab.snapshot = null;
    tab.page = null;
    [prepared, submitDeadline] = await prepareSubmit(tab, extensionSnapshot, submitActionId as string, observed.documentId);
  }

  let value: string | null = await source(email, field);
  let dispatched = false;
  try {
    refuseInput(); // shutdown began during the vault read: no readbacks and no private input
    if (typeof value !== "string" || !value || pyLen(value) > MAX_VALUE_LENGTH) throw new Gate("fast-chrome-private-source-invalid");
    if (field === "one-time password" && !/^[0-9]{6}$/.test(value)) throw new Gate("fast-chrome-private-source-invalid");
    await checkUrl(tab, expectedUrl);
    const fresh = await observeFields(tab, expectedUrl, fields, false, refuseInput, env);
    if (fresh.documentId !== observed.documentId) throw new Gate("fast-chrome-private-document-changed");
    if (prepared !== null && monotonic() >= submitDeadline) throw new Gate("fast-chrome-private-submit-expired");
    refuseInput(); // nothing private sent yet: a refusal is a clean block with no recorded attempt
    tab.privateAttempts.add(attempt);
    tab.snapshot = null;
    tab.page = null;
    dispatched = true;
    let result = await tab.call("privateFill", {
      expectedOrigin: tab.origin,
      token: fresh.token,
      documentId: fresh.documentId,
      values: field === "password" ? [email, value] : [value]
    });
    value = null;
    if (isDict(result) && (result.status === "not-ready" || result.status === "unsupported")) return { outcome: "not_filled", tab_id: String(tab.id), retry: false };
    if (!isDict(result) || result.status !== "filled") return { outcome: "unknown", tab_id: String(tab.id), retry: false };
    if (prepared !== null) {
      refuseInput(); // the fill was sent: a refusal stays unknown, and the submit never resumes
      result = await tab.call("submitPrivate", { submitToken: prepared.submitToken as string, documentId: prepared.documentId as string });
      if (!isDict(result) || result.status !== "executed") return { outcome: "unknown", tab_id: String(tab.id), retry: false };
      tab.privateIdentity = [email, fresh.documentId];
      return { outcome: "submitted", tab_id: String(tab.id), field, retry: false };
    }
    return { outcome: "filled", tab_id: String(tab.id), field, retry: false };
  } catch (error) {
    if (dispatched) return { outcome: "unknown", tab_id: String(tab.id), retry: false };
    throw error;
  } finally {
    value = null;
  }
}
