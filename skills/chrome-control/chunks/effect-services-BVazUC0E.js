const require_Layer = require("./Layer-nAKmzBoW.js");
let node_fs = require("node:fs");
node_fs = require_Layer.__toESM(node_fs);
let node_child_process = require("node:child_process");
node_child_process = require_Layer.__toESM(node_child_process);
//#region ../../../browser-platform-personal-capture-20260920/op-chrome/node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/FiberRef.js
/**
* @since 2.0.0
* @category fiberRefs
*/
var currentLoggers = require_Layer.currentLoggers;
//#endregion
//#region ../../../browser-platform-personal-capture-20260920/op-chrome/node_modules/.pnpm/effect@3.21.2/node_modules/effect/dist/esm/Logger.js
/**
* @since 2.0.0
* @category constructors
*/
var defaultLogger = require_Layer.defaultLogger;
/**
* A default version of the pretty logger.
*
* @since 3.8.0
* @category constructors
*/
var prettyLoggerDefault = require_Layer.prettyLoggerDefault;
//#endregion
//#region ../../../browser-platform-personal-capture-20260920/op-chrome/node_modules/.pnpm/@effect+platform@0.96.1_effect@3.21.2/node_modules/@effect/platform/dist/esm/Runtime.js
/**
* @since 1.0.0
*/
/**
* @category teardown
* @since 1.0.0
*/
var defaultTeardown = (exit, onExit) => {
	onExit(require_Layer.isFailure(exit) && !require_Layer.isInterruptedOnly(exit.cause) ? 1 : 0);
};
var addPrettyLogger = (refs, fiberId) => {
	const loggers = require_Layer.getOrDefault(refs, currentLoggers);
	if (!require_Layer.has(loggers, defaultLogger)) return refs;
	return require_Layer.updateAs(refs, {
		fiberId,
		fiberRef: currentLoggers,
		value: loggers.pipe(require_Layer.remove(defaultLogger), require_Layer.add(prettyLoggerDefault))
	});
};
/**
* @category constructors
* @since 1.0.0
*/
var makeRunMain = (f) => require_Layer.dual((args) => require_Layer.isEffect(args[0]), (effect, options) => {
	return f({
		fiber: options?.disableErrorReporting === true ? require_Layer.runFork(effect, { updateRefs: options?.disablePrettyLogger === true ? void 0 : addPrettyLogger }) : require_Layer.runFork(require_Layer.tapErrorCause(effect, (cause) => {
			if (require_Layer.isInterruptedOnly(cause)) return require_Layer._void;
			return require_Layer.logError(cause);
		}), { updateRefs: options?.disablePrettyLogger === true ? void 0 : addPrettyLogger }),
		teardown: options?.teardown ?? defaultTeardown
	});
});
//#endregion
//#region ../../../browser-platform-personal-capture-20260920/op-chrome/node_modules/.pnpm/@effect+platform-node@0.106.0_@effect+cluster@0.58.2_@effect+platform@0.96.1_effect@3.2_a80e93d5c9b0cafd3a2a57951ab69ada/node_modules/@effect/platform-node/dist/esm/NodeRuntime.js
/**
* @since 1.0.0
*/
/**
* @since 1.0.0
* @category runtime
*/
var runMain = /* @__PURE__ */ makeRunMain(({ fiber, teardown }) => {
	const keepAlive = setInterval(require_Layer.constVoid, 2 ** 31 - 1);
	let receivedSignal = false;
	fiber.addObserver((exit) => {
		if (!receivedSignal) {
			process.removeListener("SIGINT", onSigint);
			process.removeListener("SIGTERM", onSigint);
		}
		clearInterval(keepAlive);
		teardown(exit, (code) => {
			if (receivedSignal || code !== 0) process.exit(code);
		});
	});
	function onSigint() {
		receivedSignal = true;
		process.removeListener("SIGINT", onSigint);
		process.removeListener("SIGTERM", onSigint);
		fiber.unsafeInterruptAsFork(fiber.id());
	}
	process.on("SIGINT", onSigint);
	process.on("SIGTERM", onSigint);
});
//#endregion
//#region src/scripts/effect-services.ts
var ScriptIo = class extends require_Layer.Tag("opzero/ScriptIo")() {};
function toError(error) {
	return error instanceof Error ? error : new Error(String(error || "Unknown error"));
}
var ScriptIoLive = require_Layer.succeed(ScriptIo, {
	exists: (file) => require_Layer.sync(() => node_fs.default.existsSync(file)),
	readText: (file) => require_Layer.try_({
		try: () => node_fs.default.readFileSync(file, "utf8"),
		catch: toError
	}),
	writeText: (file, text) => require_Layer.try_({
		try: () => {
			node_fs.default.writeFileSync(file, text);
		},
		catch: toError
	}),
	mkdir: (dir) => require_Layer.try_({
		try: () => {
			node_fs.default.mkdirSync(dir, { recursive: true });
		},
		catch: toError
	}),
	chmod: (file, mode) => require_Layer.try_({
		try: () => {
			node_fs.default.chmodSync(file, mode);
		},
		catch: toError
	}),
	readdir: (dir) => require_Layer.try_({
		try: () => node_fs.default.readdirSync(dir),
		catch: toError
	}),
	execFile: (command, args, options) => require_Layer.try_({
		try: () => String(node_child_process.default.execFileSync(command, args, options)),
		catch: toError
	}),
	execFileInherit: (command, args) => require_Layer.try_({
		try: () => {
			node_child_process.default.execFileSync(command, args, { stdio: "inherit" });
		},
		catch: toError
	}),
	stdout: (text) => require_Layer.sync(() => {
		process.stdout.write(text);
	}),
	stderr: (text) => require_Layer.sync(() => {
		process.stderr.write(text);
	})
});
function runScript(program) {
	runMain(require_Layer.provide(program, ScriptIoLive));
}
function argValue(name, fallback) {
	const prefix = `--${name}=`;
	const direct = process.argv.find((arg) => arg.startsWith(prefix));
	if (direct) return direct.slice(prefix.length);
	const index = process.argv.indexOf(`--${name}`);
	if (index !== -1) return process.argv[index + 1];
	return fallback || null;
}
//#endregion
Object.defineProperty(exports, "ScriptIo", {
	enumerable: true,
	get: function() {
		return ScriptIo;
	}
});
Object.defineProperty(exports, "argValue", {
	enumerable: true,
	get: function() {
		return argValue;
	}
});
Object.defineProperty(exports, "runScript", {
	enumerable: true,
	get: function() {
		return runScript;
	}
});
