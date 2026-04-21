---
'@ait-co/console-cli': patch
---

Rename the CLI to `aitcc`, replace the OAuth-callback login scaffold with a Chrome DevTools Protocol flow, and wire `whoami` to the live console API.

## Breaking: CLI renamed

The executable is now `aitcc` (Apps in Toss Community Console). Shorter than the previous `ait-console`, matches the organization's short name, and leaves `ait-console` free in case the official Toss team ever ships their own tool. The npm package name (`@ait-co/console-cli`) is unchanged.

- Binary: `ait-console-<os>-<arch>[.exe]` → `aitcc-<os>-<arch>[.exe]`.
- Session directory: `$XDG_CONFIG_HOME/ait-console/` → `$XDG_CONFIG_HOME/aitcc/`. Existing sessions read as "no session" — re-run `aitcc login` once.
- Env vars: `AIT_CONSOLE_*` → `AITCC_*` (`AITCC_BROWSER`, `AITCC_OAUTH_URL`, `AITCC_VERSION` build-time define, `AITCC_INSTALL_DIR`, `AITCC_QUIET`).

Binary users: re-run `install.sh` to pick up the renamed asset. npm users: reinstall the package so the new `bin` entry lands in your `$PATH`.

## `aitcc login` now captures cookies via CDP

The old flow waited for an OAuth callback on `127.0.0.1` — which never worked because the registered redirect on the public client_id is the production domain, not localhost. The new flow launches the user's system Chrome/Edge/Chromium in an isolated temporary profile, navigates to the Apps in Toss sign-in URL, and captures the session cookies (including `HttpOnly`) over CDP once the browser reaches the post-login workspace page. No OAuth redirect URI configuration is required.

## `aitcc whoami` is live by default

`whoami` now calls the console's `members/me/user-info` endpoint, printing your name, email, role, and workspace list. Pass `--offline` to read only the cached identity. Exit codes: 0 on success, 10 when the session is missing or expired, 11 on network failure, 17 on other API errors.

## Removed

The `oauth.ts` callback server, `--no-browser` flag, and `AIT_CONSOLE_OAUTH_CLIENT_ID` / `AIT_CONSOLE_OAUTH_SCOPE` env overrides are gone. Override the authorize URL with `AITCC_OAUTH_URL` and the browser executable with `AITCC_BROWSER` if needed.
