# Skills slice parity

The skills slice writes agent documentation only: `skills/browser-control/**`, `skills/onepassword-session/SKILL.md`, and `skills/create-verification-skill/**`. It ports no Python module, so no `test_*.py` function maps to this slice. Every entry in `python-inventory.json` belongs to the foundation, pool, private, or server slice.

Checks this slice relies on instead of Python tests:

- Each `SKILL.md` has YAML frontmatter with a `name` that matches its directory (lowercase letters, digits, and single hyphens, at most 64 characters) and a non-empty `description` of at most 1024 characters.
- The skills contain no organization-specific, account-pool, or user-specific names or paths. The only allowed configuration path is the documented OpenCode skills install directory in `skills/browser-control/references/setup.md`.
- Tool names and argument names in the skills match `tests/server/fixtures/python-tools.json`, with the Q2 removal of `lease_id` from `paste_1password_field`.
