// Preloaded with --require into an installer process for the manifest retargeting tests. The first time the
// installer opens its temporary manifest file (.com.opzero.chrome.json.<uuid>.tmp), which it does only once it
// holds the manifest lock and has classified the manifest, this points the symlink RETARGET_LINK at
// RETARGET_TARGET, as another user who owned that symlink could, and appends the path being opened to
// RETARGET_MARK.
import fs from "node:fs";
import path from "node:path";

const TEMPORARY = /^\.com\.opzero\.chrome\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.tmp$/;
const { RETARGET_LINK: link, RETARGET_TARGET: target, RETARGET_MARK: mark } = process.env;
const openSync = fs.openSync;
let repointed = false;

function retargeting(this: unknown, ...args: Parameters<typeof fs.openSync>): number {
  if (!repointed && link && target && mark && TEMPORARY.test(path.basename(String(args[0])))) {
    repointed = true;
    fs.unlinkSync(link);
    fs.symlinkSync(target, link);
    fs.appendFileSync(mark, `${String(args[0])}\n`);
  }
  return openSync.apply(fs, args);
}

fs.openSync = retargeting as typeof fs.openSync;
