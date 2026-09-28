import { NativeHostStatusSchema, parseWithSchema, type NativeHostStatus } from "../shared/extension-schemas";

const statusPill = document.getElementById("status-pill") as HTMLSpanElement;
const summary = document.getElementById("summary") as HTMLParagraphElement;
const details = document.getElementById("details") as HTMLElement;
const hostName = document.getElementById("host-name") as HTMLElement;
const lastChecked = document.getElementById("last-checked") as HTMLElement;
const errorText = document.getElementById("error-text") as HTMLElement;
const version = document.getElementById("version") as HTMLElement;
const reloadButton = document.getElementById("reload-host") as HTMLButtonElement;
const pauseButton = document.getElementById("pause-host") as HTMLButtonElement;
const extensionsLink = document.getElementById("open-extensions") as HTMLAnchorElement;

version.textContent = `Version v${chrome.runtime.getManifest().version}`;

let currentState = "pending";

function formatTime(ms?: number) {
  if (!ms) return "-";
  return new Date(ms).toLocaleString();
}

function renderStatus(status: Partial<NativeHostStatus> = {}) {
  const state = status.state || "disconnected";
  currentState = state;
  const connected = state === "connected";
  const paused = state === "paused";
  const connecting = state === "connecting";
  const hostMissing = !status.error || /not found/i.test(status.error);
  statusPill.className = `pill ${connected ? "connected" : paused ? "paused" : connecting ? "pending" : "disconnected"}`;
  statusPill.textContent = connected ? "Connected" : paused ? "Paused" : connecting ? "Connecting" : "Disconnected";
  summary.textContent = connected
    ? "Connected to the local agent host."
    : paused
      ? "Native host paused. Resume to reconnect."
      : connecting
        ? "Starting the local native host..."
        : hostMissing
          ? "Install the native host to connect."
          : "Native host stopped. It restarts automatically, or click Reload host.";
  hostName.textContent = status.hostName || "-";
  lastChecked.textContent = formatTime(status.lastChecked);
  errorText.textContent = status.error || "-";
  details.hidden = connected && !status.error;
  pauseButton.textContent = paused ? "Resume host" : "Pause host";
}

function setBusy(busy: boolean) {
  reloadButton.disabled = busy;
  pauseButton.disabled = busy;
}

function handleResponse(response: { status?: unknown } | undefined) {
  setBusy(false);
  if (chrome.runtime.lastError) {
    renderStatus({ state: "disconnected", error: chrome.runtime.lastError.message, lastChecked: Date.now() });
    return;
  }
  renderStatus(parseWithSchema(NativeHostStatusSchema, response?.status) || { state: "disconnected", lastChecked: Date.now() });
}

function sendControl(type: "RELOAD_NATIVE_HOST" | "PAUSE_NATIVE_HOST" | "RESUME_NATIVE_HOST") {
  setBusy(true);
  chrome.runtime.sendMessage({ type }, handleResponse);
}

async function loadStoredStatus() {
  const { NATIVE_HOST_STATUS } = await chrome.storage.local.get("NATIVE_HOST_STATUS");
  const status = parseWithSchema(NativeHostStatusSchema, NATIVE_HOST_STATUS);
  if (status) renderStatus(status);
}

function refreshStatus() {
  chrome.runtime.sendMessage({ type: "GET_NATIVE_HOST_STATUS" }, (response: { status?: unknown } | undefined) => {
    if (chrome.runtime.lastError) {
      renderStatus({ state: "disconnected", error: chrome.runtime.lastError.message, lastChecked: Date.now() });
      return;
    }
    renderStatus(parseWithSchema(NativeHostStatusSchema, response?.status) || { state: "disconnected", lastChecked: Date.now() });
  });
}

reloadButton.addEventListener("click", () => sendControl("RELOAD_NATIVE_HOST"));
pauseButton.addEventListener("click", () => sendControl(currentState === "paused" ? "RESUME_NATIVE_HOST" : "PAUSE_NATIVE_HOST"));
extensionsLink.addEventListener("click", (event) => {
  event.preventDefault();
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

chrome.storage.onChanged.addListener((changes, area) => {
  const status = parseWithSchema(NativeHostStatusSchema, changes.NATIVE_HOST_STATUS?.newValue);
  if (area === "local" && status) renderStatus(status);
});

loadStoredStatus().finally(refreshStatus);
