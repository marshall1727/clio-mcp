/**
 * Token storage.
 *  - Windows: DPAPI (CurrentUser) via PowerShell – the blob can only be decrypted under the same
 *    Windows account on the same PC. No native modules.
 *  - Elsewhere (development/test): AES-256-GCM with the key in a file with 0600 permissions (marked as fallback).
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { config } from "./config.js";
import { t } from "./i18n.js";

export interface TokenSet {
  access_token: string;
  refresh_token: string;
  token_type: string;
  expires_at: number; // unix ms
  obtained_at: number; // unix ms
  user?: { id: number; name?: string; email?: string };
}

function ensureDir() {
  fs.mkdirSync(config.dataDir, { recursive: true });
}

const isWin = process.platform === "win32";

function psRun(script: string, input: string): string {
  const res = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
    { input, encoding: "utf8", windowsHide: true, timeout: 20000 }
  );
  if (res.error) throw res.error;
  if (res.status !== 0) throw new Error(t("runtime.dpapi_failed", { detail: res.stderr?.trim() || res.status }));
  return res.stdout.trim();
}

function dpapiProtect(plain: string): Buffer {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$in = [Console]::In.ReadToEnd(); " +
    "$bytes = [System.Text.Encoding]::UTF8.GetBytes($in); " +
    "$out = [System.Security.Cryptography.ProtectedData]::Protect($bytes, $null, 'CurrentUser'); " +
    "[Convert]::ToBase64String($out)";
  return Buffer.from(psRun(script, plain), "base64");
}

function dpapiUnprotect(blob: Buffer): string {
  const script =
    "Add-Type -AssemblyName System.Security; " +
    "$in = [Console]::In.ReadToEnd().Trim(); " +
    "$bytes = [Convert]::FromBase64String($in); " +
    "$out = [System.Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, 'CurrentUser'); " +
    "[System.Text.Encoding]::UTF8.GetString($out)";
  return psRun(script, blob.toString("base64"));
}

// ---- fallback (non-Windows) ----
function fallbackKey(): Buffer {
  ensureDir();
  const keyFile = path.join(config.dataDir, "key.bin");
  if (fs.existsSync(keyFile)) return fs.readFileSync(keyFile);
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyFile, key, { mode: 0o600 });
  return key;
}

function aesEncrypt(plain: string): Buffer {
  const key = fallbackKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from("AESG"), iv, cipher.getAuthTag(), enc]);
}

function aesDecrypt(blob: Buffer): string {
  const key = fallbackKey();
  const iv = blob.subarray(4, 16);
  const tag = blob.subarray(16, 32);
  const enc = blob.subarray(32);
  const d = crypto.createDecipheriv("aes-256-gcm", key, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(enc), d.final()]).toString("utf8");
}

export const storeBackend = isWin ? "dpapi" : "aes-gcm-file";

let cache: TokenSet | null | undefined;

export function loadTokens(): TokenSet | null {
  if (cache !== undefined) return cache;
  try {
    if (!fs.existsSync(config.tokenFile)) return (cache = null);
    const blob = fs.readFileSync(config.tokenFile);
    const json = isWin ? dpapiUnprotect(blob) : aesDecrypt(blob);
    cache = JSON.parse(json) as TokenSet;
    return cache;
  } catch (e) {
    cache = null;
    throw new Error(t("runtime.tokens_load_failed", { detail: (e as Error).message }));
  }
}

export function saveTokens(tokens: TokenSet): void {
  ensureDir();
  const json = JSON.stringify(tokens);
  const blob = isWin ? dpapiProtect(json) : aesEncrypt(json);
  fs.writeFileSync(config.tokenFile, blob, { mode: 0o600 });
  cache = tokens;
}

export function clearTokens(): void {
  cache = null;
  if (fs.existsSync(config.tokenFile)) fs.unlinkSync(config.tokenFile);
}
