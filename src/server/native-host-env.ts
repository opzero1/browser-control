// Runs before src/native-host/host.ts in dist/server/native-host.js. That host reads its endpoint from
// OPZERO_CHROME_HOST_SOCKET; the stable host takes it only from BROWSER_CONTROL_HOST_SOCKET (D19), which the
// generated wrapper exports. host.ts itself stays unchanged, because its build output is published elsewhere.
const socket = process.env.BROWSER_CONTROL_HOST_SOCKET;
if (socket) process.env.OPZERO_CHROME_HOST_SOCKET = socket;
else delete process.env.OPZERO_CHROME_HOST_SOCKET;

export {};
