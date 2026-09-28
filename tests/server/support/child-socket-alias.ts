// Preloaded with --require into a native host or client for the socket path tests. It stands in for another user
// who controls a symlink in the socket path and can predict the host's pid; no test can be a second uid.
//   ALIAS_PLANT: at load, `{pid}` in it is replaced by this process's pid and something is made there: a symlink to
//     ALIAS_PLANT_TARGET when that is set, else a regular file holding "keep".
//   ALIAS_LINK, ALIAS_TARGET, ALIAS_AFTER: once an lstat of a path whose last component is ALIAS_AFTER has
//     returned, which is when the host has checked the socket's directory, point the symlink ALIAS_LINK at
//     ALIAS_TARGET. This happens once.
//   ALIAS_LINK, ALIAS_TARGET, ALIAS_AT_CONNECT: the same, once, when the process calls net.connect or
//     net.createConnection, just before the connection is made: after any check the process made.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const { ALIAS_PLANT: plant, ALIAS_PLANT_TARGET: plantTarget, ALIAS_LINK: link, ALIAS_TARGET: target, ALIAS_AFTER: after, ALIAS_AT_CONNECT: atConnect } = process.env;

if (plant) {
  const file = plant.replace("{pid}", String(process.pid));
  if (plantTarget) fs.symlinkSync(plantTarget, file);
  else fs.writeFileSync(file, "keep");
}

let repointed = false;
function repoint() {
  if (repointed || !link || !target) return;
  repointed = true;
  fs.unlinkSync(link);
  fs.symlinkSync(target, link);
}

if (link && target && after) {
  const lstatSync = fs.lstatSync;
  const hooked = function (this: unknown, ...args: Parameters<typeof fs.lstatSync>) {
    const stats = lstatSync.apply(fs, args);
    if (path.basename(String(args[0])) === after) repoint();
    return stats;
  };
  fs.lstatSync = hooked as typeof fs.lstatSync;
}

if (link && target && atConnect) {
  for (const name of ["connect", "createConnection"] as const) {
    const original = net[name] as (...args: unknown[]) => net.Socket;
    (net as unknown as Record<string, unknown>)[name] = function (this: unknown, ...args: unknown[]) {
      repoint();
      return original.apply(net, args);
    };
  }
}
