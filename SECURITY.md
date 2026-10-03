# Security

## Design

- **Local only.** The server is a Node.js process started by Claude Desktop on the user's computer and talks directly to `https://<region>.app.clio.com`. There is no hosted component, telemetry or update check.
- **OAuth 2.0 Authorization Code** with a loopback redirect (`http://127.0.0.1:53682–53684/callback`) and a random `state` value. The authorization code is exchanged in the background; the tool call itself never blocks on the browser.
- **Secrets.** The Clio App Secret is a `sensitive` field of the Desktop Extension manifest, so Claude Desktop keeps it in the Windows Credential Manager and passes it to the process as an environment variable. Access and refresh tokens are stored in `%USERPROFILE%\.clio-mcp\tokens-<region>.bin`, encrypted with **Windows DPAPI (CurrentUser)** – readable only by the same Windows user on the same machine. On non-Windows systems (development only) an AES-256-GCM file store with a 0600 key file is used and `clio_diagnostics` reports it as a fallback.
- **Least privilege by construction.**
  - No tool deletes anything. `DELETE` is rejected in the generic API tool's schema and again in the HTTP client, so even a future tool could not send it by accident.
  - Every write tool can return a preview. In the `ask` confirmation mode the preview carries an HMAC-based confirmation token bound to the tool and its exact arguments (per-process secret); the write is performed only when the same arguments are sent again with that token, and `confirm=true` or mismatched tokens are rejected – the model cannot write without first producing a preview for the user. In the default `auto` mode the model writes directly when the request is complete (`confirm=true`), which is a deliberate convenience trade-off the firm chooses in the settings.
  - Requests to the generic API tool are validated against Clio's OpenAPI description (unknown path → refused; unknown parameters → warning).
  - The connector never bypasses Clio's role-based redaction; redacted fields are shown as such.
- **Audit log.** `%USERPROFILE%\.clio-mcp\audit.jsonl` (append-only, mode 0600): timestamp, Clio user, tool, parameters with secrets removed, outcome. The log never contains tokens or the App Secret.
- **stdout discipline.** `stdout` is reserved for the MCP protocol; all library output is redirected to `stderr`, so no data leaks into the transport by accident.
- **Dependencies** are pinned through `package-lock.json`; the bundle is built with esbuild from this repository. The only native module is `@napi-rs/canvas` (PDF/image rendering), shipped as a prebuilt binary for Windows x64.

## What a compromised machine could do

The threat model is the user's own PC. Anyone who can run code as the signed-in Windows user can decrypt the token file (DPAPI) and read the Credential Manager entry, exactly as they could read a browser session. Protect the PC accordingly (disk encryption, screen lock, no shared accounts). Revoking the application in Clio Manage (*Settings → Apps*) invalidates all tokens immediately.

## Revoking access

- Per PC: ask Claude to sign you out (`clio_logout`, with `revoke=true` to also invalidate the access token in Clio).
- For all PCs and users at once: in Clio Manage remove the Developer Application under *Settings → Apps*, or rotate the App Secret in the developer portal.

## Reporting a vulnerability

Please report security issues privately through GitHub's **Report a vulnerability** form on the repository's *Security* tab (https://github.com/marshall1727/clio-mcp/security/advisories/new). Do not open a public issue for security problems and never include tokens, App Secrets or client data in a report. You should receive an acknowledgement within a few days; fixes are released as a new `.mcpb` and announced in `CHANGELOG.md`.
