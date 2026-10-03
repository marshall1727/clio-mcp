# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Planned
- macOS and Linux builds (Keychain / Secret Service token store, native renderer for other platforms).
- Optional listing in the Clio App Directory.

## [1.0.0-beta.1] – 2026-10-03

First public version, derived from an internal connector that has been in daily use since September 2026 (internal versions 0.1–0.3.3).

### Added
- Preview → confirm handshake enforced by the server: previews return a confirmation token bound to the arguments; `confirm=true` is rejected, so a write is impossible without a preceding preview.
- `clio_document_create_from_letterhead` refuses empty content and instructs the model to ask for the text first.
- English as the source language throughout (tool titles, descriptions, parameters, comments); runtime messages go through a small message catalog (`src/i18n.ts`, `src/locales/`) with English and Czech, selected by the *Language of messages* setting (`CLIO_LOCALE`).
- Bring-your-own Developer Application: region, App Key and App Secret are entered in the extension settings; no credentials are shipped with the package.
- Letterhead selection without firm-specific defaults: explicit `template`/`template_id` per call, per-user map, firm-wide default template, or the only template in Clio.
- Documents generated from text: generic `Label:: text` syntax for bold labels; heading styles resolved by Word's built-in style names with fallbacks; hanging indent and extra labels adjustable through environment variables (`CLIO_DOCX_INDENT_CM`, `CLIO_DOCX_LABELS`) – not exposed in the extension settings.
- `DELETE` is now also refused inside the HTTP client (defence in depth).
- `npm run fetch-spec` downloads Clio's OpenAPI description; `npm run pack` builds the `.mcpb`.
- English README with a step-by-step installation guide, SECURITY.md, PRIVACY.md, NOTICE.

### Changed
- Package renamed to `clio-mcp`; manifest, settings and build scripts rewritten in English.
- Default work folder is `Documents\Clio MCP`.

### Inherited from the internal versions (0.3.x)
- 55 tools covering documents (including reading scans as images and server-side filling of letterheads), time and expenses, billing data, matters, contacts, tasks, calendar, notes, communications, users, custom fields and a validated generic API call.
- Preview-then-confirm for all writes, no delete tools, append-only audit log, DPAPI-encrypted tokens, request queue honouring Clio's rate limits, cursor pagination.
- 0.3.3 fix: the "Claude" folder in a matter is found by listing sub-folders (Clio's `/folders?query=` does not match existing folders), so it is no longer created repeatedly.
