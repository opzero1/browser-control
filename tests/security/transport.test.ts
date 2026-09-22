import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect, it } from "vitest";
import { ChromeTransport } from "../../src/native-host/transport";
import { testTemp } from "../support/temp";

async function endpoint(observationError: string, check: (client: ChromeTransport, methods: string[]) => Promise<void>, versions = { host: 2, transport: 2, page: 2 }) {
  const root = testTemp();
  const socketPath = path.join(root, "s");
  const methods: string[] = [];
  const sockets = new Set<net.Socket>();
  let observations = 0;
  const server = net.createServer(socket => {
    sockets.add(socket);
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", chunk => {
      buffer += chunk;
      for (let index; (index = buffer.indexOf("\n")) >= 0;) {
        const request = JSON.parse(buffer.slice(0, index)); buffer = buffer.slice(index + 1);
        methods.push(request.method);
        const result = request.method === "host.info" ? { protocolVersion: versions.host, extensionProtocol: "ready", session_id: "test", epoch: "test" }
          : request.method === "getInfo" ? { protocolVersion: versions.transport, pageProtocolVersion: versions.page }
          : request.method === "createTab" ? { id: 1, active: false }
          : request.method === "observePage" ? { status: "observed", pageProtocolVersion: 2, snapshot: "fresh", url: "https://synthetic.invalid/", title: "Ready", text: "Ready", actions: [], mode: "full", partial: false, opaqueSurfaces: [], truncation: { text: false, actions: false, opaqueSurfaces: false, labels: false, title: false } }
          : {};
        const failed = request.method === "observePage" && observations++ === 0;
        socket.write(JSON.stringify({ jsonrpc: "2.0", id: request.id, ...(failed ? { error: { code: -1, message: observationError } } : { result }) }) + "\n");
      }
    });
  });
  let client: ChromeTransport | undefined;
  try {
    await new Promise<void>(resolve => server.listen(socketPath, resolve));
    client = await ChromeTransport.connect(socketPath);
    await check(client, methods);
  } finally {
    await client?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>(resolve => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}

it("waits through a removed main frame by repeating only observation", async () => {
  await endpoint("Frame with ID 0 was removed.", async (client, methods) => {
    const page = await client.open("https://synthetic.invalid/");
    expect((await client.waitFor(page, { text: "Ready" }, 500)).snapshot).toBe("fresh");
    expect(methods.filter(method => method === "observePage")).toHaveLength(2);
    expect(methods.filter(method => method === "navigatePage")).toHaveLength(1);
    expect(methods.filter(method => ["actPage", "privateFill", "submitPrivate"].includes(method))).toHaveLength(0);
  });
});

it.each(["Page owner revoked", "Transport closed; outcome unknown; no replay"])("does not hide %s while waiting", async error => {
  await endpoint(error, async (client, methods) => {
    const page = await client.open("https://synthetic.invalid/");
    await expect(client.waitFor(page, { text: "Ready" }, 500)).rejects.toThrow(error);
    expect(methods.filter(method => method === "observePage")).toHaveLength(1);
  });
});

it.each(["host", "transport", "page"] as const)("rejects a mismatched %s protocol before page use", async key => {
  await expect(endpoint("unused", async () => { throw new Error("unexpected connection"); }, { host: 2, transport: 2, page: 2, [key]: 1 })).rejects.toThrow(/protocol/);
});
