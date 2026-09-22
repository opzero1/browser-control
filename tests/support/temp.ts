import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function testTemp(prefix = "oc-") {
  const root = process.env.OPZERO_TEST_TMPDIR || path.join(os.tmpdir(), "opencode");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  return fs.mkdtempSync(path.join(root, prefix));
}
