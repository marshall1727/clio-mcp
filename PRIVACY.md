# Privacy

This document describes what the **clio-mcp** Desktop Extension does with data. It is written for law-firm users and their data-protection officers; it is not legal advice.

## Who processes what

| Party | Data | Basis |
| --- | --- | --- |
| **Clio** (Themis Solutions Inc.) | Everything the connector reads from or writes to your Clio Manage account. | Your existing agreement with Clio; see https://www.clio.com/privacy/. |
| **Anthropic** (the Claude model and app) | Whatever Claude receives as tool results (document text, page images, matter and contact data, time entries…) and whatever you type. | The terms of **your** Anthropic plan. Commercial plans (Team, Enterprise, API) and consumer plans differ in retention and training terms – check before using the connector on client files. |
| **The connector itself** | Nothing leaves your computer except requests to Clio's API. There is no telemetry, analytics or crash reporting, and no third-party service. | – |
| **The project maintainer** | Nothing. The maintainer has no access to your installation, tokens or data. | – |

## What is stored on your computer

| Item | Location | Protection | Purpose |
| --- | --- | --- | --- |
| Clio App Secret | Windows Credential Manager (managed by Claude Desktop) | OS-level | OAuth token exchange and refresh |
| Access and refresh tokens, your Clio user id/name/e-mail | `%USERPROFILE%\.clio-mcp\tokens-<region>.bin` | Windows DPAPI (CurrentUser) | Staying signed in |
| Audit log | `%USERPROFILE%\.clio-mcp\audit.jsonl` | NTFS permissions of your profile | Record of every tool call (who, when, what, outcome); secrets redacted. Contains matter/document identifiers and the parameters you asked Claude to send, so treat it as confidential. |
| Downloaded documents and local copies of documents created by Claude | The *Work folder* from the extension settings (default `Documents\Clio MCP`), one sub-folder per matter | NTFS permissions | Editing in Cowork; keeping a copy of generated documents |

Nothing is cached beyond that; document text and page images are passed to Claude and discarded.

## Deleting your data

- Sign out (`clio_logout`) deletes the token file. Deleting `%USERPROFILE%\.clio-mcp` removes tokens and the audit log; deleting the work folder removes local document copies.
- Revoking the application in Clio Manage (*Settings → Apps*) invalidates all tokens issued to it.
- Conversations with Claude are governed by your Anthropic plan's retention settings.

## Children

The connector is a professional tool for Clio Manage users and is not directed at children.

## Changes

Changes to this document are recorded in `CHANGELOG.md`.
