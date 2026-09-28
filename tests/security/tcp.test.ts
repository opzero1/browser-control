import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { testTemp } from "../support/temp";

it("authenticates TCP from a private file and never forwards pre-auth disconnects", async () => {
  const directory = testTemp();
  const tokenFile = path.join(directory, "token");
  const token = randomBytes(32).toString("hex");
  fs.writeFileSync(tokenFile, token, { mode: 0o600 });
  const reservation = net.createServer();
  await new Promise<void>(resolve => reservation.listen(0, "127.0.0.1", resolve));
  const address = reservation.address();
  if (!address || typeof address === "string") throw new Error("No address");
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const env = { ...process.env, OPZERO_CHROME_HOST_TRANSPORT: "tcp", OPZERO_CHROME_HOST_PORT: String(address.port), OPZERO_CHROME_HOST_TOKEN_FILE: tokenFile };
  const host = spawn(process.execPath, ["dist/native-host/host.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  let buffer = Buffer.alloc(0);
  const requests: any[] = [];
  host.stdout.on("data", chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32LE(0)) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, length + 4).toString()); buffer = buffer.subarray(length + 4);
      requests.push(message);
      if (message.method === "getInfo") {
        const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 2 } }));
        const header = Buffer.alloc(4); header.writeUInt32LE(body.length); host.stdin.write(Buffer.concat([header, body]));
      }
    }
  });
  const sockets: net.Socket[] = [];
  try {
    await vi.waitFor(() => expect(requests).toHaveLength(1));
    const socket = await vi.waitFor(() => new Promise<net.Socket>((resolve, reject) => {
      const candidate = net.connect(address.port, "127.0.0.1");
      candidate.once("connect", () => resolve(candidate));
      candidate.once("error", reject);
    }));
    sockets.push(socket);
    let denied = "";
    socket.on("data", chunk => { denied += chunk; });
    socket.write('{"jsonrpc":"2.0","id":1,"method":"createTab","params":{}}\n');
    await vi.waitFor(() => expect(denied).toContain("Authentication required"));
    await vi.waitFor(() => expect(socket.destroyed).toBe(true));
    expect(requests).toHaveLength(1);
    const client = spawn(process.execPath, ["dist/native-host/client.js", "host.info"], { env, stdio: ["ignore", "pipe", "pipe"] });
    let output = ""; let errors = "";
    client.stdout.on("data", chunk => { output += chunk; }); client.stderr.on("data", chunk => { errors += chunk; });
    const code = await new Promise(resolve => client.on("close", resolve));
    expect(code).toBe(0);
    expect(JSON.parse(output).result.extensionProtocol).toBe("ready");
    expect(output + errors).not.toContain(token);
  } finally {
    sockets.forEach(socket => socket.destroy());
    host.kill();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
