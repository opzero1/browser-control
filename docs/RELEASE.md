# Release

A release has four parts: the extension package on the Chrome Web Store, the GitHub Release with the native host and skill, the website on Cloudflare Pages, and the store listing text and images. They are all built from this repository.

## Identifiers

| What | Value |
| --- | --- |
| Chrome Web Store item | `dcnjjnecbhipdbngkhjppkckpkellmld` (publisher `affdn`) |
| Native messaging host | `com.opzero.chrome` |
| Website | <https://browser-control.pages.dev/> (Cloudflare Pages project `browser-control`, account `affdn`) |
| Privacy policy | <https://browser-control.pages.dev/privacy/> |
| Store API service account | `cws-publisher@opzero-chrome.iam.gserviceaccount.com` (Google Cloud project `opzero-chrome`) |

Release builds embed the store extension ID from `scripts/extension-id.store.json` in the packaged skill, so the native host installer allows the store extension by default. Set `BROWSER_CONTROL_EXTENSION_ID` only to build a package for a different extension ID. The `Release` workflow reads it from the repository variable of the same name, and falls back to the store ID when the variable is unset.

The store package must not contain a manifest `key`. `pnpm run check` refuses one, and it also pins the exact permission list. Unpacked builds get their ID from their folder path.

## 1. Prepare the version

1. Raise `version` in `src/extension/manifest.json` and `package.json`, and the host version in `src/native-host/host.ts`. The version must be higher than every version the store has, including rejected drafts. Check the dashboard's **Package** page or run the workflow with `action: status`.
2. If a permission, data flow or stored key changes, update `store/listing.md`, `site/privacy/index.html` and `docs/PRIVACY.md` together. The dashboard's Privacy tab must match the privacy policy.
3. Run `pnpm run check`. It rebuilds `dist/` and the committed `skills/browser-control` files. Commit the regenerated files.

## 2. Merge and tag

Merge to `main`, then tag the merge commit:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The `Release` workflow creates the GitHub Release with `browser-control-extension.zip` and `browser-control-skill.zip`. The README downloads `browser-control-skill.zip` from the latest release, so publish the release before you submit to the store.

## 3. Deploy the website

Deploy after every release, and whenever anything under `site/` changes. The site also hosts the helper zip that the homepage and the reviewer steps download, so copy the freshly built one in first. `site/download/` is not committed.

```sh
pnpm run build
mkdir -p site/download
cp dist/release/browser-control-skill.zip site/download/browser-control-skill.zip
cp dist/release/browser-control-skill.zip site/download/chrome-control-skill.zip
npx wrangler pages deploy site --project-name browser-control --branch main
```

`/download/chrome-control-skill.zip` is an alias that serves the same file as `/download/browser-control-skill.zip`. It exists for the dashboard's "Additional instructions for reviewers" field. That field links to the old path, and the Chrome Web Store API cannot change it. After the field is updated in the dashboard to link to `/download/browser-control-skill.zip`, the alias can go: update the short form in `store/reviewer-test-instructions.md` and `store/listing.md`, delete `site/download/chrome-control-skill.zip`, remove the second `cp` line, and deploy again.

Check that `/`, `/privacy/`, `/support/`, `/support/reviewers/`, `/download/browser-control-skill.zip` and `/download/chrome-control-skill.zip` return HTTP 200, and that both zips match the build:

```sh
shasum -a 256 dist/release/browser-control-skill.zip
curl -fsSL https://browser-control.pages.dev/download/browser-control-skill.zip | shasum -a 256
curl -fsSL https://browser-control.pages.dev/download/chrome-control-skill.zip | shasum -a 256
```

Keep the `google-site-verification` meta tag in `site/index.html`. It proves ownership of the site in Google Search Console, which the listing's official URL requires. Cloudflare Pages redirects `.html` URLs to extensionless ones, so the HTML-file verification method does not work on this site.

### Renamed helper

0.2.2 is the first release after the rename. Its extension code is the same as in 0.2.1 apart from the version. The skill is `browser-control` and its zip is `browser-control-skill.zip`. The host, client and scripts read `BROWSER_CONTROL_*` variables and no longer read the `OPZERO_CHROME_*` names. The installer writes a `browser-control-host` wrapper. The native host name `com.opzero.chrome` and the default socket `~/.opzero-chrome/default.sock` are unchanged.

What changed with it:

- 0.2.2 replaced the pending 0.2.1 submission, which described the old helper. That review was cancelled with `action: cancel` before 0.2.2 was uploaded.
- `store/listing.md`, `store/reviewer-test-instructions.md` and the pages under `site/` describe the 0.2.2 helper: the `/download/browser-control-skill.zip` link, the `browser-control-host` wrapper, the `BROWSER_CONTROL_HOST_SOCKET` excerpt and `"version":"0.2.2"` from `getInfo`. Only the dashboard short form still links to `/download/chrome-control-skill.zip`, through the alias above.
- Create the repository variable `BROWSER_CONTROL_EXTENSION_ID` if the old `OPZERO_CHROME_EXTENSION_ID` variable was set. The `Release` workflow no longer reads the old name.
- Existing installs keep working until they are reinstalled. A reinstall from the new zip goes to `~/.config/opencode/skills/browser-control`, so remove the old `skills/chrome-control` folder.

### Installer changed after 0.2.2

The release zip's installer, `scripts/install-native-host.js`, changed on `afif/ts-server` after 0.2.2 was submitted. `store/`, `site/` and `docs/PRIVACY.md` still describe the 0.2.2 installer, which is deployed and published on the store, so they stay as they are until the next release. The installer now:

- Publishes the host and its chunks as a stable copy, `hosts/skill-<digest>/`, under the state root (`BROWSER_CONTROL_STATE_DIR`, default `~/.local/state/browser-control`). It writes the wrapper `hosts/skill/browser-control-host` there, and the manifest names that wrapper instead of `native-host/browser-control-host` in the unzipped folder.
- Runs the host with `process.execPath`, the Node that ran the installer, instead of searching `PATH` and fixed locations.
- Refuses to replace a `com.opzero.chrome` manifest that names another host unless `--force` is given. That includes a manifest from the 0.2.2 helper and one from `npx -y @op1/browser-control install`.
- Prints a new `Host copy:` line, and writes nothing into the unzipped folder, including `scripts/extension-id.json`.
- Keeps the default socket `~/.opzero-chrome/default.sock`.

Before the next release:

1. Refresh the expected output of "3. Install the native messaging host" in `store/reviewer-test-instructions.md` and `site/support/reviewers/index.html`: `Host executable:` is `~/.local/state/browser-control/hosts/skill/browser-control-host`, and a `Host copy:` line follows it. Say that a reviewer who installed an earlier helper must pass `--force`. Add the state root's `hosts/skill` and `hosts/skill-*` directories to "9. Clean up".
2. Update "Files on your computer" in `docs/PRIVACY.md` and `site/privacy/index.html` together, and check the matching text in `store/listing.md`.
3. Re-run the whole reviewer flow from a fresh download of the built zip, with the lowest Node version the steps name, and compare every "Expected" line with the real output.

## 4. Upload to the Chrome Web Store

Run the `Chrome Web Store` workflow from GitHub Actions:

```sh
gh workflow run chrome-web-store.yml -f ref=vX.Y.Z -f action=upload
```

| `action` | Effect |
| --- | --- |
| `status` | Reads the published and submitted state of the item. Changes nothing. |
| `upload` | Builds `ref`, runs the checks, and replaces the draft package. |
| `submit` | Same as `upload`, then submits the draft for review. |
| `cancel` | Cancels the pending review submission. It does not build `ref` or change the package. The status in the same run is read before the cancel, so run `status` again to confirm. |

The workflow signs in to Google through Workload Identity Federation. GitHub's OIDC token is exchanged for a short-lived access token for the `cws-publisher` service account, so the repository holds no Google credential. The trust is limited to workflows in `opzero1/browser-control`.

| Setting | Kind | Value |
| --- | --- | --- |
| `GCP_WORKLOAD_IDENTITY_PROVIDER` | Repository variable | `projects/458096566052/locations/global/workloadIdentityPools/github/providers/browser-control` |
| `GCP_SERVICE_ACCOUNT` | Repository variable | `cws-publisher@opzero-chrome.iam.gserviceaccount.com` |
| `CHROME_EXTENSION_ID` | Secret | The store item ID |
| `CHROME_PUBLISHER_ID` | Secret | The dashboard's publisher ID |

The service account is registered in the dashboard under **Settings > Service account**. The Google Cloud side is the `github` workload identity pool, its `browser-control` OIDC provider with the condition `assertion.repository=='opzero1/browser-control'`, and a `roles/iam.workloadIdentityUser` binding on the service account for that repository.

Without the workflow, upload `dist/release/browser-control-extension.zip` on the dashboard's **Package** page.

## 5. Update the listing and submit

Before you submit, compare the dashboard with the repository:

- **Store listing**: description, category and URLs from `store/listing.md`; screenshots and promo tiles from `store/assets/`.
- **Privacy**: single purpose, permission justifications, remote code answer, data usage and certifications from `store/listing.md`; privacy policy URL `https://browser-control.pages.dev/privacy/`.
- **Test instructions**: the short form in `store/reviewer-test-instructions.md`.
- **Distribution**: Public, all regions.

Then submit for review, from the dashboard or with `action: submit`. Google reviews every version. Because the item requests `debugger` and `<all_urls>`, expect an in-depth review that can take several days.

## Store images

`store/capture/` rebuilds the screenshots and promo tiles from a real session in a disposable Chrome for Testing profile. See `store/assets/README.md`. Recapture them when the popup, tab groups or cursor change.

## History

- 0.1.2 was published.
- 0.1.3 was rejected on 1 July 2026 for "User data privacy" (reference Purple Nickel). Its privacy policy link pointed to a GitHub file, and Google does not accept a repository page as a privacy policy. The fix was a hosted policy at `https://browser-control.pages.dev/privacy/`.
- 0.2.1 renames the item from Chrome Control to Browser Control, as the branding guidelines require, and drops the unused `history` and `downloads` permissions. It was submitted for review on 28 September 2026 with automatic publishing after approval, from the extension source at `5717395`. Its review was cancelled the same day so that 0.2.2 could replace it.
- 0.2.2 was submitted from the `v0.2.2` tag on 28 September 2026 and went live on 30 September 2026. It is the first published version named Browser Control.
- The old `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET` and `CHROME_REFRESH_TOKEN` secrets belong to an OAuth client whose consent screen stayed in testing mode, so its refresh tokens expired after seven days. The workflow no longer uses them.
