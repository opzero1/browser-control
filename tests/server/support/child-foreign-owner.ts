// Preloaded with --require into an installer or a client. Tests cannot chown, so this stands in for files that
// another user or root owns: fs.lstatSync of a path listed in FOREIGN_OWNED reports another uid, and of a path
// listed in ROOT_OWNED reports uid 0. Both lists are joined with path.delimiter. Nothing else changes.
import fs from "node:fs";
import path from "node:path";

const list = (value: string | undefined) => new Set((value ?? "").split(path.delimiter).filter(Boolean));
const foreign = list(process.env.FOREIGN_OWNED);
const root = list(process.env.ROOT_OWNED);

if (foreign.size || root.size) {
  const lstatSync = fs.lstatSync;
  const hooked = function (this: unknown, ...args: Parameters<typeof fs.lstatSync>) {
    const stats = lstatSync.apply(fs, args) as fs.Stats;
    const file = String(args[0]);
    if (!foreign.has(file) && !root.has(file)) return stats;
    return Object.assign(Object.create(Object.getPrototypeOf(stats)), stats, { uid: foreign.has(file) ? stats.uid + 1 : 0 });
  };
  fs.lstatSync = hooked as typeof fs.lstatSync;
}
