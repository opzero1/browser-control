// The built native host (dist/native-host/host.js), started as Chrome starts it, with a fake extension on its
// native messaging pipes that speaks protocol 2 and answers the calls a ping and a transport open and close make.
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";

export interface RunningHost {
  readonly child: ChildProcess;
  /** Every request the host forwarded to the extension, other than its internal.* calls, such as a client's release. */
  readonly native: { method: string; params: Record<string, unknown> }[];
  stop(): Promise<void>;
}

const ANSWERS: Record<string, unknown> = {
  ping: "pong",
  getInfo: { protocolVersion: 2, pageProtocolVersion: 2 },
  createTab: { id: 7, active: false }
};

/** Start the host with `env`, and resolve once it answers host.info at `endpoint`, its canonical socket path. */
export async function startHost(env: NodeJS.ProcessEnv, endpoint: string): Promise<RunningHost> {
  const child = spawn(process.execPath, ["dist/native-host/host.js"], { env, stdio: ["pipe", "pipe", "pipe"] });
  child.stdin?.on("error", () => undefined);
  const native: RunningHost["native"] = [];
  let buffer = Buffer.alloc(0);
  const send = (message: unknown) => {
    const body = Buffer.from(JSON.stringify(message));
    const header = Buffer.alloc(4);
    header.writeUInt32LE(body.length);
    child.stdin?.write(Buffer.concat([header, body]));
  };
  child.stdout?.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
      const length = buffer.readUInt32LE(0);
      const message = JSON.parse(buffer.subarray(4, length + 4).toString());
      buffer = buffer.subarray(length + 4);
      if (typeof message.id === "string" && message.id.startsWith("protocol:")) {
        send({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: 2 } });
        continue;
      }
      if (!String(message.method).startsWith("internal.")) native.push({ method: message.method, params: message.params });
      send({ jsonrpc: "2.0", id: message.id, result: message.method in ANSWERS ? ANSWERS[message.method] : {} });
    }
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const deadline = Date.now() + 8000;
  while (!(await answers(endpoint))) {
    if (child.exitCode !== null || Date.now() > deadline) {
      child.kill("SIGKILL");
      throw new Error(`the host did not answer at ${endpoint}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return {
    child,
    native,
    async stop() {
      if (child.exitCode === null) child.kill("SIGTERM");
      await exited;
    }
  };
}

/** Whether a host answers host.info with extensionProtocol "ready" at `endpoint`. */
function answers(endpoint: string): Promise<boolean> {
  if (!fs.existsSync(endpoint) || fs.existsSync(`${endpoint}.lock`)) return Promise.resolve(false);
  return new Promise((resolve) => {
    const socket = net.connect(endpoint);
    socket.setEncoding("utf8");
    socket.once("error", () => resolve(false));
    socket.once("connect", () => socket.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "host.info" })}\n`));
    socket.once("data", (chunk) => {
      socket.destroy();
      try {
        resolve(JSON.parse(String(chunk)).result?.extensionProtocol === "ready");
      } catch {
        resolve(false);
      }
    });
  });
}
