// Python's type(value) is int at the native-host boundary: host results parsed from the socket keep integer and
// float literals apart, so 5.0 is refused where Python refused it even though a JS number cannot tell them apart.
// Each case runs through a real Connection to a fake host that writes the number forms verbatim.
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../../src/server/app";
import { Gate } from "../../../src/server/gate";
import { Connection } from "../../../src/server/host-connection";
import { tabInfo } from "../../../src/server/page";
import { prepareSubmit, type PrivateTab } from "../../../src/server/private/private-input";
import { Shutdown } from "../../../src/server/runtime/shutdown";
import { FakeHost, RawJson, result, type Handler } from "../support/fake-host";
import { privateTemp, removeTempRoots, testEnv } from "../support/temp";

const hosts: FakeHost[] = [];
const connections: Connection[] = [];

afterEach(async () => {
  for (const connection of connections.splice(0)) connection.close();
  for (const host of hosts.splice(0)) await host.close();
  removeTempRoots();
});

async function host(handler: Handler): Promise<FakeHost> {
  const started = await FakeHost.start(path.join(privateTemp(), "host.sock"), { handler });
  hosts.push(started);
  return started;
}

async function connection(handler: Handler): Promise<Connection> {
  const opened = await Connection.open((await host(handler)).path);
  connections.push(opened);
  return opened;
}

async function gateOf(promise: Promise<unknown>): Promise<string | null> {
  return promise.then(() => null, (error: unknown) => (error instanceof Gate ? error.code : Promise.reject(error)));
}

const page = (version: string) => new RawJson(`{"status":"observed","pageProtocolVersion":${version},"snapshot":"token",`
  + "\"url\":\"https://example.test/\",\"title\":\"Fixture\",\"text\":\"Ready\",\"mode\":\"full\",\"partial\":false,\"opaqueSurfaces\":[],"
  + "\"truncation\":{\"text\":false,\"actions\":false,\"opaqueSurfaces\":false,\"labels\":false,\"title\":false},"
  + "\"actions\":[{\"id\":\"0\",\"kind\":\"click\",\"label\":\"Continue\",\"role\":\"button\",\"disabled\":false}]}");

describe("native-host integers", () => {
  it("refuses a host tab id written as a float literal", async () => {
    const tabs = await connection((socket, request) => result(socket, request,
      new RawJson("[{\"id\":5,\"url\":\"https://example.test/\",\"title\":\"a\"},{\"id\":5.0,\"url\":\"https://example.test/\",\"title\":\"b\"},"
        + "{\"id\":5e0,\"url\":\"https://example.test/\",\"title\":\"c\"}]")));
    const [integer, float, exponent] = await tabs.call("getTabs") as unknown[];
    expect(tabInfo(integer)).toEqual({ tab_id: "5", url: "https://example.test/", title: "a" });
    for (const row of [float, exponent]) expect(() => tabInfo(row)).toThrow(new Gate("fast-chrome-invalid-tab-response"));
  });

  it("refuses an observed page whose protocol version is a float literal", async () => {
    const outcomes: Record<string, unknown> = {};
    for (const version of ["2", "2.0"]) {
      const root = privateTemp();
      const answers: Record<string, unknown> = {
        createTab: { id: 5, active: false, url: "about:blank", title: "" }, attach: { attached: true },
        bindPage: { bound: true }, navigatePage: { status: "dispatched" }, finalizeTabs: { closedOrReleased: true }, getTabs: [], getUserTabs: []
      };
      let observed = 0;
      const endpoint = await host((socket, request) => {
        // open_tab's own readback sees an integer version; the later observe sees `version`.
        if (request.method === "observePage") return result(socket, request, page(observed++ ? version : "2"));
        if (request.method === "nameSession") return result(socket, request, { name: request.params.name, confirmed: true });
        result(socket, request, answers[request.method]);
      });
      const shutdown = new Shutdown();
      const app = createApp({ env: testEnv(root, { BROWSER_CONTROL_STATE_DIR: root, BROWSER_CONTROL_HOST_SOCKET: endpoint.path }), shutdown, version: "0.0.0-test" });
      const meta = { "ai.opencode/sessionID": "ses_numbers" };
      const opened = await app.callTool("open_tab", { url: "https://example.test/" }, meta);
      expect(JSON.parse((opened.content[0] as { text: string }).text).outcome).toBe("opened");
      const read = await app.callTool("observe", { tab_id: "5" }, meta);
      outcomes[version] = read.isError ? (read.content[0] as { text: string }).text : "observed";
      shutdown.begin();
      await app.cleanup(shutdown.deadline as number);
    }
    expect(outcomes).toEqual({ "2": "observed", "2.0": "Error executing tool observe: fast-chrome-observation-unavailable" });
  });

  it("refuses a private submit lifetime written as a float literal", async () => {
    const outcomes: Record<string, string | null> = {};
    for (const lifetime of ["90000", "90000.0", "9e4"]) {
      const host = await connection((socket, request) => result(socket, request,
        new RawJson(`{"status":"prepared","submitToken":"submit-token","documentId":"document-1","expiresInMs":${lifetime}}`)));
      const tab = { call: (method: string, params?: Record<string, never>) => host.call(method, params) } as unknown as PrivateTab;
      outcomes[lifetime] = await gateOf(prepareSubmit(tab, "token", "0", "document-1"));
    }
    expect(outcomes).toEqual({ "90000": null, "90000.0": "fast-chrome-private-submit-not-prepared", "9e4": "fast-chrome-private-submit-not-prepared" });
  });
});
