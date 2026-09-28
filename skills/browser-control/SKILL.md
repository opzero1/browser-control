---
name: browser-control
description: "Operate Chrome through Browser Control: the MCP server's tools, and the bundled native host scripts for extension connection checks, host install and repair, and raw client calls."
---

# Browser Control

Browser Control is a Chrome extension, a native messaging host, and an MCP server.

## Use the bundled host scripts

This skill ships the native host and its scripts next to this file. Use them to check that the extension answers (`node native-host/client.js ping`), to install or repair the host from the release zip (`node scripts/install-native-host.js`), and for raw client calls. Follow [native host scripts](references/native-host.md).
