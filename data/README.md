# Vendored data

`public_suffix_list.dat` is the Public Suffix List, including ICANN and private rules, used to map hosts to
cookie sites (`src/server/sites.ts`).

- Source: https://publicsuffix.org/list/public_suffix_list.dat
- Fetched: 2026-09-26 (2026-09-25T17:23Z)
- `// VERSION: 2026-09-24_13-26-36_UTC`
- `// COMMIT: a179a48c465e818cfd8d626691cb317985da87fb`
- Size: 334,786 bytes
- SHA-256: `257b298daca42f6d8ec964e238c2a55518e14f09d3117917ec8acee6f188503e`

The server refuses a file with any other hash (`fast-chrome-public-suffix-list-mismatch`). To update it,
replace the file, update `PSL_SHA256` in `src/server/sites.ts`, this README and the check in
`scripts/check-project.js`, and rerun the site tests. The list is published under the Mozilla Public
License 2.0.

`../native/clipboard-guard/clipboard_guard.swift` is copied verbatim from the reference fast-chrome server.
`browser-control install` builds it into `<state>/bin/clipboard-guard-<sha12>`.
