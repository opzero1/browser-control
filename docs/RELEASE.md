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

Release builds embed the store extension ID from `scripts/extension-id.store.json` in the packaged skill, so the native host installer allows the store extension by default. Set `OPZERO_CHROME_EXTENSION_ID` only to build a package for a different extension ID.

The store package must not contain a manifest `key`. `pnpm run check` refuses one, and it also pins the exact permission list. Unpacked builds get their ID from their folder path.

## 1. Prepare the version

1. Raise `version` in `src/extension/manifest.json` and `package.json`, and the host version in `src/native-host/host.ts`. The version must be higher than every version the store has, including rejected drafts. Check the dashboard's **Package** page or run the workflow with `action: status`.
2. If a permission, data flow or stored key changes, update `store/listing.md`, `site/privacy/index.html` and `docs/PRIVACY.md` together. The dashboard's Privacy tab must match the privacy policy.
3. Run `pnpm run check`. It rebuilds `dist/` and the committed `skills/chrome-control` files. Commit the regenerated files.

## 2. Merge and tag

Merge to `main`, then tag the merge commit:

```sh
git tag vX.Y.Z
git push origin vX.Y.Z
```

The `Release` workflow creates the GitHub Release with `browser-control-extension.zip` and `chrome-control-skill.zip`. The reviewer instructions and the README download `chrome-control-skill.zip` from the latest release, so publish the release before you submit to the store.

## 3. Deploy the website

Deploy after every release, and whenever anything under `site/` changes. The site also hosts the helper zip that the homepage and the reviewer steps download, so copy the freshly built one in first. `site/download/` is not committed.

```sh
pnpm run build
mkdir -p site/download
cp dist/release/chrome-control-skill.zip site/download/
npx wrangler pages deploy site --project-name browser-control --branch main
```

Check that `/`, `/privacy/`, `/support/`, `/support/reviewers/` and `/download/chrome-control-skill.zip` return HTTP 200. Keep the `google-site-verification` meta tag in `site/index.html`. It proves ownership of the site in Google Search Console, which the listing's official URL requires. Cloudflare Pages redirects `.html` URLs to extensionless ones, so the HTML-file verification method does not work on this site.

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

- 0.1.2 was published and is live.
- 0.1.3 was rejected on 1 July 2026 for "User data privacy" (reference Purple Nickel). Its privacy policy link pointed to a GitHub file, and Google does not accept a repository page as a privacy policy. The fix was a hosted policy at `https://browser-control.pages.dev/privacy/`.
- 0.2.1 renames the item from Chrome Control to Browser Control, as the branding guidelines require, and drops the unused `history` and `downloads` permissions.
- The old `CHROME_CLIENT_ID`, `CHROME_CLIENT_SECRET` and `CHROME_REFRESH_TOKEN` secrets belong to an OAuth client whose consent screen stayed in testing mode, so its refresh tokens expired after seven days. The workflow no longer uses them.
