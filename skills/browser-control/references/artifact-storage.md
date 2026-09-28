# Save capture artifacts

Call `screenshot({tab_id})`. It returns the viewport image and an absolute path to the same JPEG. The server creates a private `chrome-capture-*` directory under the tab's bound artifact root.

- A [browser lease](browser-pool.md) uses its receipt's `artifacts` directory, a per-lease directory under the controller in the state root, created during `claim_browser` readiness setup. Shared and exclusive leases each get a separate directory.
- Without a lease, the root is `FAST_CHROME_ARTIFACT_ROOT` when the server's environment sets it; that directory must already exist and be private to the current user. Otherwise the root is `artifacts/user` in the state root (`BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`), created with mode 0700 on first use.

Retain the receipt's `artifacts` path and each capture's exact returned path. Do not scan a shared directory by timestamp.

Downloads use the controller-wide `downloads` directory and require an exclusive lease. Read its path from the browser receipt. Keep downloads distinct from per-lease screenshots and recordings. Browser release, stopping a controller, and profile reset keep both directories.

Inspect the returned image before you cite it as evidence. Read the saved file when the image was omitted or the task requires independent file verification. The server saves JPEG bytes with a `.jpg` extension. Copy the artifact only when the task needs another authorized destination. Keep deliverables until the consuming task finishes, then remove only that task's files.

Video capture returns its MP4 path through `stop_recording`. See [video capture](video-capture.md) for timing and verification.

Frames, embeds, and shadow roots do not block capture. Choose content appropriate for the task and inspect the saved image. Known private-input quarantine and populated recognized private fields still block capture; embedded content is not exhaustively inspected. Stop recording before private credential entry, and wait for navigation away from that document before capture.

If a save fails, inspect the reported directory and its permissions. The server refuses an artifact root that is missing, not a directory, readable by other users, or under a directory that another user could change: every directory and symlink on the way to it must be yours or root's and not writable by others unless it has the sticky bit.
