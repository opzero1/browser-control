// Subprocess helper for the stdio tests: the real MCP server on stdin and stdout, as an MCP client starts it.
// The state root, host socket and Public Suffix List come from the environment (BROWSER_CONTROL_STATE_DIR,
// BROWSER_CONTROL_HOST_SOCKET, BROWSER_CONTROL_TEST_PSL), because the bundle cannot locate the package files.
//   [barrier]   replace the vault with a synthetic reader: it creates <barrier>/entered, waits until
//               <barrier>/resume exists, then returns the contents of <barrier>/secret
import fs from "node:fs";
import path from "node:path";
import { createApp, type ReadField } from "../../../src/server/app";
import { runStdioServer } from "../../../src/server/entry";
import { usePublicSuffixListForTesting } from "../../../src/server/sites";
import { sleep } from "../../../src/server/time";

if (process.env.BROWSER_CONTROL_TEST_PSL) usePublicSuffixListForTesting(process.env.BROWSER_CONTROL_TEST_PSL);
const [barrier] = process.argv.slice(2);

const vault: ReadField | undefined = barrier ? async () => {
  fs.writeFileSync(path.join(barrier, "entered"), "");
  while (!fs.existsSync(path.join(barrier, "resume"))) await sleep(10);
  return fs.readFileSync(path.join(barrier, "secret"), "utf8");
} : undefined;

void runStdioServer({ app: (options) => createApp({ ...options, version: "0.0.0-test", ...(vault ? { readField: vault } : {}) }) });
