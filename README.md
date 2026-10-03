# clio-mcp – Claude ↔ Clio Manage

An [MCP](https://modelcontextprotocol.io) server that lets Claude work inside your **Clio Manage** account through Clio's official API v4. It is installed as a **Desktop Extension** for Claude Desktop (also available in Cowork) and runs only on your own computer – there is no server in between you and Clio.

> **Status:** 1.0.0-beta.1 · Windows x64 · all Clio regions (US, EU, CA, AU) · licence Apache-2.0
> This project is not affiliated with Clio or Anthropic.

## What it does

| Area | What Claude can do |
| --- | --- |
| **Documents** | Find documents in a matter · read the text of DOCX/PDF/TXT files · read **scanned PDFs and images** (pages are handed to Claude as pictures, so it reads them itself) · download a document to a folder on your PC for editing · upload the edited file as a **new version** · create a **new document on your letterhead** (Claude writes the text, the server puts it into your Clio Document Template and saves it in a "Claude" folder in the matter) · rewrite a document Claude created · create folders · add comments |
| **Time & expenses** | List and summarise time entries (per matter, user, period, billed/unbilled) · record time and expenses · edit entries · activity codes and rates · timer status/start |
| **Billing data** | Matters with unbilled work · list bills · bill details with line items · update a bill (state, memo, dates) or a line item · outstanding balances |
| **Matters & contacts** | Search, view, create and update matters and contacts · practice areas · custom fields |
| **Tasks & calendar** | Tasks (create, update, complete) · calendars and calendar entries |
| **Other** | Notes · communication log · users · text snippets |
| **Anything else in the API** | `clio_describe_api` finds the right endpoint in Clio's OpenAPI description; `clio_api_request` calls it (GET/POST/PATCH) with validation of path, parameters and body |

55 tools in total. Claude sees short instructions from the server (check sign-in first, preview before writing, where new documents go), so in practice you just ask: *"Record 0.5 h on the Smith matter for today's call"*, *"What's unbilled on Smith?"*, *"Read the last letter in the Smith matter and draft a reply on my letterhead."*

## What it deliberately does **not** do

- **Nothing is ever deleted.** The connector has no delete tools and the generic API call refuses the `DELETE` method – both in the tool definition and in the HTTP client. If something needs deleting (a test time entry, a duplicate folder, a timer that must be stopped – Clio stops timers with `DELETE /timer`), do it in Clio itself.
- **You decide how writes are confirmed.** The *Write confirmation* setting has two modes (details below): **auto** (default) – Claude records the time, creates the document or updates the task directly when your request is complete, and asks only when information is missing; **ask** – every write first shows you a preview and is carried out only after your approval, which the server enforces with a confirmation token.
- **No bills are created or sent.** Clio's API only lets bills be read and edited; sending invoices to clients stays in Clio.
- **No way around Clio permissions.** If your Clio role hides something (rates, bills, other users' time), the API returns it as `redacted` and the connector shows exactly that.
- **No cloud component.** Tokens, the audit log and downloaded documents stay on your computer. The only parties that see your data are Clio and the Claude model you talk to (under your Anthropic plan's terms).

## Installation (step by step)

You need: Claude Desktop on Windows (64-bit), a Clio Manage account whose plan allows developer applications (not available on Clio's EasyStart plan), and about 15 minutes.

### Step 1 – Create a Developer Application in Clio

The connector signs in to Clio with OAuth, like any Clio integration. For that Clio needs to know the application, so you register one yourself. **One application per firm is enough** – every user then signs in with it on their own PC.

1. Open the developer portal for **your region** and sign in with your Clio login:
   - US: https://developers.clio.com
   - EU: https://eu.developers.clio.com
   - Canada: https://ca.developers.clio.com
   - Australia: https://au.developers.clio.com
2. Click **Add** (new application) and fill in:
   - **Name:** e.g. `Claude connector` (your users will see this name on Clio's consent screen and under *Settings → Apps*).
   - **Website URL:** your firm's website (any valid URL).
   - **Redirect URIs** – add all three, exactly as written:
     ```
     http://127.0.0.1:53682/callback
     http://127.0.0.1:53683/callback
     http://127.0.0.1:53684/callback
     ```
   - **Permissions (scopes):** tick **read and write** for the areas you want Claude to use. For the full tool set that is: Activities, Api, Billing, Calendars, Communications, Contacts, Custom fields, Documents, General, Matters, Reporting, Settings, Tasks, Users. (Scopes are fixed when a user authorises the app; if you add scopes later, every user has to sign in again.)
   - Accept Clio's Developer Terms of Service and save.
3. Clio shows the application's **App Key** and **App Secret**. Keep this page open – you will paste both values in step 3. Treat the App Secret like a password (do not send it by e-mail or paste it into a chat).

Clio's own guide: https://docs.developers.clio.com/api-docs/clio-manage/applications/

### Step 2 – Install the extension in Claude Desktop

1. Download `clio-mcp-<version>.mcpb` from the [Releases](https://github.com/marshall1727/clio-mcp/releases) page.
2. In Claude Desktop open **Settings → Extensions → Advanced settings** and click **Install Extension…**, then pick the downloaded `.mcpb` file. (Double-clicking the file in Explorer works too.)
3. Claude Desktop shows the extension's settings form (step 3).

### Step 3 – Fill in the settings

| Setting | What to enter |
| --- | --- |
| **Clio region** | `us`, `eu`, `ca` or `au` – the region your Clio account lives in (look at the address bar when you use Clio: `app.clio.com` = us, `eu.app.clio.com` = eu, …). |
| Language of messages | Optional, default `en`. Language of previews, errors and notes (`en` or `cs`). Tool descriptions are always English; Claude answers in whatever language you write. |
| Write confirmation | Optional, default `auto`. How Claude confirms writes to Clio – see [Write confirmation modes](#write-confirmation-modes). |
| **Clio App Key (Client ID)** | The App Key from step 1. |
| **Clio App Secret (Client Secret)** | The App Secret from step 1. Claude Desktop stores it in the Windows Credential Manager, not in a file. |
| Work folder for documents | Optional. Folder on your PC where documents are downloaded for editing (default `Documents\Clio MCP`). If you use Cowork, connect the same folder there. |
| Folder name in Clio for documents created by Claude | Optional, default `Claude`. Created automatically in each matter's documents. |
| Default letterhead / template | Optional. Name (or beginning of the name, or id) of the Clio *Document Template* to use for new documents. Leave empty if you have only one template or want to choose per document. |
| Per-user letterheads | Optional. If each lawyer has their own letterhead template: `jane@firm.com=Jane_letterhead;john@firm.com=John_letterhead`. The connector picks the template by the e-mail of the signed-in user. |
| Template for internal documents | Optional. Template used when Claude is asked for an internal document (`kind=internal`). |

Save, enable the extension and **restart Claude Desktop**.

### Step 4 – Sign in to Clio (once per user and PC)

In a new chat type: **"Sign me in to Clio."** Claude calls `clio_authenticate`, which returns a link and opens your browser. Sign in to Clio, review the permissions and click **Allow**. Back in the chat ask **"Who am I in Clio?"** – you should see your name. The sign-in is remembered (Clio refresh tokens do not expire), so you will not be asked again unless you revoke access.

Each colleague repeats steps 2–4 on their own PC with the **same** App Key and App Secret; they sign in with their own Clio account.

### Updating

Install the new `.mcpb` over the old one (or uninstall → install). Settings are kept; if Claude Desktop asks for the App Secret again, paste it from your password manager. Saved sign-ins in `%USERPROFILE%\.clio-mcp` are kept.

## Everyday use

**Read a document:** *"Open the latest filing in matter 2026-0042 and summarise it."* – Claude uses `clio_document_search` → `clio_document_read`. The text comes back directly; scanned pages come back as images (4 pages per call, more on request).

**Draft on letterhead:** *"Draft a letter to the opposing counsel in matter 2026-0042 on my letterhead."* – Claude writes the text and calls `clio_document_create_from_letterhead` with `content`; you see a preview; after your OK the server fills your Clio template and saves the DOCX in the matter's *Claude* folder. Later corrections: *"Change the second paragraph…"* → `clio_document_write` creates a new version.

**Edit an existing document (Cowork):** download → Claude edits the file in your connected work folder → `clio_document_upload_version` after your confirmation. The previous version stays in Clio's version history.

**Record time:** *"Record 1.2 h on 2026-0042, 'review of expert report'."* → preview → confirm.

**Prepare billing:** *"Which matters have unbilled time this month?"* → `clio_billable_matters_list`, then `clio_time_entries_list` with `status: unbilled`, `clio_bill_get` for an existing draft bill.

**Everything else:** *"Find the API endpoint for court rules"* → `clio_describe_api` → `clio_api_request`.

### Documents from text – formatting

Claude passes plain text with a tiny markup; the server converts it into Word paragraphs that use the styles of **your** template:

| You write | You get |
| --- | --- |
| `# Heading`, `## Sub-heading`, `### Sub-sub-heading` | Heading 2 / 3 / 4 of the template |
| `[ 1. ] Text…` | Numbered paragraph: number at the margin, text indented (hanging indent, default 1.4 cm) |
| `Evidence:: Contract dated 1 May 2026` | **Evidence:** in bold, a tab, then the text (any label works with `::`) |
| `- item` | Bullet with indent |
| `**bold**`, a tab character | Bold run, tab |
| `:::center Text`, `:::right Text` | Centred / right-aligned paragraph |
| `---pagebreak---` | Page break |
| empty line | Empty paragraph |

Header, footer, page numbers and fonts come from the template, so the result looks like a document created with Clio's *New document* function. Advanced: the hanging indent (default 1.4 cm) and extra single-colon labels can be set through the environment variables `CLIO_DOCX_INDENT_CM` and `CLIO_DOCX_LABELS` when the server is run outside Claude Desktop.

## Write confirmation modes

Every tool that changes data in Clio (time entries, documents, tasks, contacts, bills…) can be called in two steps: a **preview** (nothing is sent) and the **write**. The *Write confirmation* setting decides who approves the write:

| Mode | What happens | For whom |
| --- | --- | --- |
| **auto** (default) | When your request already contains everything the write needs – *"Record 0.5 h on Smith for today's call"* – Claude writes it straight away and tells you what it did. It asks first only when something is missing or ambiguous (which matter, what text, which activity) and it never invents content. Claude may still use the preview internally to check the data. | Users who want speed and give complete instructions. |
| **ask** | Claude must first show you a preview of exactly what will be written and wait for your approval. The server enforces this: the preview contains a one-time confirmation token bound to those exact arguments, `confirm=true` is rejected, and the write is accepted only with the token – so a write without a preceding preview is technically impossible. | Firms that want a human check on every change, shared PCs, onboarding of new users. |

In both modes deleting is impossible and every call is written to the audit log. You can switch modes at any time in the extension settings (restart Claude Desktop afterwards).

## Safety model

- **Write confirmation** – `auto` (direct writes when the request is complete) or `ask` (server-enforced preview → token → write); see above.
- **DELETE is impossible.** Not offered as a tool, rejected by `clio_api_request`, and refused again inside the HTTP client.
- **Audit log** of every call (`%USERPROFILE%\.clio-mcp\audit.jsonl`, append-only; secrets redacted): who, when, which tool, parameters, result.
- **Tokens** are encrypted with Windows DPAPI (bound to your Windows account and PC); the App Secret lives in the Windows Credential Manager.
- **Revoking access:** say *"Sign me out of Clio"* (`clio_logout`, optionally with `revoke=true`), or in Clio Manage remove the application under *Settings → Apps* – that invalidates all tokens at once.
- Details and how to report a vulnerability: [SECURITY.md](SECURITY.md). What is stored where: [PRIVACY.md](PRIVACY.md).

## Confidentiality and professional rules

Everything Claude reads from Clio is processed by the Claude model under the terms of **your** Anthropic plan (consumer plans and commercial/Team/Enterprise plans differ in data-retention and training terms). Before using the connector on client files, check your plan's terms and any guidance from your bar or law society on the use of generative AI with confidential client information (for example ABA Formal Opinion 512 in the US, or the guidance of your national bar in Europe). This README is not legal advice.

## Languages

The server's messages (previews, errors, notes, the instructions Claude receives) are available in **English** (default) and **Czech**; choose with the *Language of messages* setting. Adding a language means translating the six small JSON files in `src/locales/en/` into `src/locales/<code>/` and registering the code in `src/i18n.ts` – pull requests welcome. Tool names, descriptions and output field names are English only, since they are read by the model.

## Known limitations

- Windows x64 only in this beta (token storage uses Windows DPAPI; the PDF/image renderer is a native module). macOS/Linux are planned.
- Clio's rate limit is 50 requests/minute per user; the connector queues and waits, so very large listings are slow.
- Field selection follows Clio's rules (nested fields only one level deep); `clio_describe_api {schema: "Matter"}` lists valid fields.
- Stopping a timer requires `DELETE /timer`, which this connector never sends – stop timers in Clio.
- Clio's API cannot create bills; bills are created in Clio and only read/edited here.
- Document Automation (Clio-side generation) needs templates with merge fields; the connector's own *text → letterhead* filling works with any DOCX template.

## Troubleshooting

| Symptom | What to do |
| --- | --- |
| "Not signed in" | Ask Claude to sign you in (`clio_authenticate`); afterwards check with `clio_auth_status`. |
| Browser shows a Clio error after *Allow* | The redirect URIs in your Developer Application must be exactly the three `http://127.0.0.1:5368x/callback` addresses. |
| `401` keeps coming back | Token revoked in Clio or wrong region – check the *Clio region* setting matches your account, then sign in again. |
| `403 Forbidden` | Missing scope on the Developer Application (add it, then every user re-authorises) or your Clio role does not allow the action. |
| `400 … is not a valid field` | Wrong `fields` parameter; `clio_describe_api {schema: "…"}` shows valid fields. |
| `429` | Rate limit; the connector waits for `Retry-After` automatically. |
| Claude cannot open a downloaded file | In Cowork connect the folder set as *Work folder*; in a normal Claude Desktop chat use `clio_document_read` (text) instead of downloading. |
| `clio_diagnostics` | Shows configuration, token store, work folder and version – useful when reporting an issue. |

## Building from source

```bash
npm install
npm run fetch-spec   # downloads Clio's OpenAPI description into spec/ (not committed)
npm run catalog      # regenerates src/generated/catalog.json from it
npm run build        # type-check + bundle → dist/index.js
npm run pack         # → release/clio-mcp-<version>.mcpb (Windows x64; needs @napi-rs/canvas-win32-x64-msvc in node_modules)
```

Project layout: `src/index.ts` (server, instructions for the model), `src/config.ts` (settings), `src/oauth.ts` (OAuth with loopback redirect), `src/store.ts` (encrypted token store), `src/client.ts` (HTTP client: refresh, queue, rate limit, paging), `src/catalog.ts` (OpenAPI catalog and request validation), `src/extract.ts` (DOCX/PDF text and page images), `src/docx.ts` (text → DOCX on a template), `src/tools/*` (the tools), `pkg/manifest.json` (Desktop Extension manifest).

## Contributing

Issues and pull requests are welcome at https://github.com/marshall1727/clio-mcp. Please do not include real client data, App Secrets or tokens in bug reports; the output of `clio_diagnostics` and the relevant lines of the audit log (with identifiers removed) are usually enough.

## Licence

Apache License 2.0 – see [LICENSE](LICENSE) and [NOTICE](NOTICE).
