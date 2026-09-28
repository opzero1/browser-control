#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_effect_services = require("../chunks/effect-services-DcZl9PNJ.js");
//#region src/scripts/chrome-is-running.ts
var json = process.argv.includes("--json");
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
	const [cmd, args] = process.platform === "win32" ? ["tasklist", []] : ["pgrep", ["-fl", "Google Chrome|Chromium"]];
	const output = yield* require_Layer.either(io.execFile(cmd, args, { encoding: "utf8" }));
	const processList = output._tag === "Right" ? output.right : "";
	const running = /chrome|chromium/i.test(processList);
	const result = {
		ok: running,
		status: running ? "running" : "not-running",
		browser: "Google Chrome",
		message: running ? "Chrome is running" : "Chrome is not running"
	};
	yield* io.stdout(json ? `${JSON.stringify(result, null, 2)}\n` : `${result.message}\n`);
	process.exitCode = running ? 0 : 1;
}));
//#endregion
