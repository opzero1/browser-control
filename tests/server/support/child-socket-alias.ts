// Preloaded with --require into a native host for the socket path tests. It stands in for another user who controls
// a symlink in the socket path and can predict the host's pid; no test can be a second uid.
//   ALIAS_PLANT: at load, `{pid}` in it is replaced by this process's pid and something is made there: a symlink to
//     ALIAS_PLANT_TARGET when that is set, else a regular file holding "keep".
//   ALIAS_LINK, ALIAS_TARGET, ALIAS_AFTER: once an lstat of a path whose last component is ALIAS_AFTER has
//     returned, which is when the host has checked the socket's directory, point the symlink ALIAS_LINK at
//     ALIAS_TARGET. This happens once.
import fs from "node:fs";
import path from "node:path";

const { ALIAS_PLANT: plant, ALIAS_PLANT_TARGET: plantTarget, ALIAS_LINK: link, ALIAS_TARGET: target, ALIAS_AFTER: after } = process.env;

if (plant) {
  const file = plant.replace("{pid}", String(process.pid));
  if (plantTarget) fs.symlinkSync(plantTarget, file);
  else fs.writeFileSync(file, "keep");
}

if (link && target && after) {
  const lstatSync = fs.lstatSync;
  let repointed = false;
  const hooked = function (this: unknown, ...args: Parameters<typeof fs.lstatSync>) {
    const stats = lstatSync.apply(fs, args);
    if (!repointed && path.basename(String(args[0])) === after) {
      repointed = true;
      fs.unlinkSync(link);
      fs.symlinkSync(target, link);
    }
    return stats;
  };
  fs.lstatSync = hooked as typeof fs.lstatSync;
}
