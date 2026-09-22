#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-nAKmzBoW.js");
const require_effect_services = require("../chunks/effect-services-BVazUC0E.js");
//#region src/scripts/open-chrome-window.ts
var json = process.argv.includes("--json");
var dryRun = process.argv.includes("--dry-run");
var url = process.argv.find((arg) => !arg.startsWith("--") && arg !== process.argv[0] && arg !== process.argv[1]) || "about:blank";
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
	const [command, args] = yield* require_Layer.try_({
		try: () => {
			if (process.platform === "darwin") return ["open", [
				"-na",
				"Google Chrome",
				"--args",
				url
			]];
			if (process.platform === "linux") return ["google-chrome", [url]];
			if (process.platform === "win32") return ["cmd", [
				"/c",
				"start",
				"chrome",
				url
			]];
			throw new Error(`Unsupported platform: ${process.platform}`);
		},
		catch: (error) => error instanceof Error ? error : new Error(String(error))
	});
	if (json) yield* io.stdout(`${JSON.stringify({
		ok: true,
		dryRun,
		command,
		args,
		url
	}, null, 2)}\n`);
	if (!dryRun) yield* io.execFileInherit(command, args);
}));
//#endregion
