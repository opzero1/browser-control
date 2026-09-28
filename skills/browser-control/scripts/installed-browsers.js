#!/usr/bin/env node
const require_Layer = require("../chunks/Layer-Dc3MJVHo.js");
const require_effect_services = require("../chunks/effect-services-DcZl9PNJ.js");
//#region src/scripts/installed-browsers.ts
var json = process.argv.includes("--json");
function commandExists(command) {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		return (yield* require_Layer.either(process.platform === "win32" ? io.execFile("where", [command], {
			encoding: "utf8",
			stdio: "ignore"
		}) : io.execFile("sh", ["-c", `command -v ${command}`], {
			encoding: "utf8",
			stdio: "ignore"
		})))._tag === "Right";
	});
}
function detect() {
	return require_Layer.gen(function* () {
		const io = yield* require_effect_services.ScriptIo;
		if (process.platform === "darwin") {
			const chrome = yield* io.exists("/Applications/Google Chrome.app");
			const chromium = yield* io.exists("/Applications/Chromium.app");
			return [{
				id: "google-chrome",
				name: "Google Chrome",
				installed: chrome
			}, {
				id: "chromium",
				name: "Chromium",
				installed: chromium
			}];
		}
		if (process.platform === "linux") {
			const chrome = (yield* commandExists("google-chrome")) || (yield* commandExists("google-chrome-stable"));
			const chromium = (yield* commandExists("chromium")) || (yield* commandExists("chromium-browser"));
			return [{
				id: "google-chrome",
				name: "Google Chrome",
				installed: chrome
			}, {
				id: "chromium",
				name: "Chromium",
				installed: chromium
			}];
		}
		if (process.platform === "win32") return [{
			id: "google-chrome",
			name: "Google Chrome",
			installed: yield* commandExists("chrome")
		}];
		return [];
	});
}
require_effect_services.runScript(require_Layer.gen(function* () {
	const io = yield* require_effect_services.ScriptIo;
	const browsers = yield* detect();
	const result = {
		ok: browsers.some((browser) => browser.installed),
		browsers
	};
	if (json) yield* io.stdout(`${JSON.stringify(result, null, 2)}\n`);
	else for (const browser of browsers) yield* io.stdout(`${browser.name}: ${browser.installed ? "installed" : "not installed"}\n`);
	process.exitCode = result.ok ? 0 : 1;
}));
//#endregion
