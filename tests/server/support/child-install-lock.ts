// Subprocess helper for the installer race tests. Mode:
//   hold <lock path>
//     Take the installers' lock (src/shared/install-lock.ts), print "held", and release it when stdin ends. A
//     SIGKILL leaves the lock behind, as a killed installer would.
import { acquireInstallLock } from "../../../src/shared/install-lock";

async function hold(lockPath: string) {
  const lock = await acquireInstallLock(lockPath);
  process.stdout.write("held\n");
  process.stdin.resume();
  process.stdin.on("end", () => {
    lock.release();
    process.exit(0);
  });
}

const [mode, lockPath] = process.argv.slice(2);
if (mode === "hold" && lockPath) void hold(lockPath);
else process.exit(2);
