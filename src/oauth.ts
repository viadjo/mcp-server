import crypto from "node:crypto";
import { authenticate } from "./auth.js";

function getSecret(): Buffer {
  const explicit = process.env.OAUTH_SECRET;
  if (explicit && explicit.length >= 64) {
    return Buffer.from(explicit, "hex");
  }
  return crypto
    .createHash("sha256")
    .update(process.env.GITHUB_TOKEN ?? "mcp-default")
    .update(":mcp-oauth")
    .digest();
}

const SECRET = getSecret();

interface CodePayload {
  apiKey: string;
  codeChallenge: string;
  redirectUri: string;
  exp: number;
}

export function createAuthorizationCode(
  apiKey: string,
  codeChallenge: string,
  redirectUri: string
): string {
  const payload: CodePayload = {
    apiKey,
    codeChallenge,
    redirectUri,
    exp: Date.now() + 5 * 60 * 1000,
  };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", SECRET, iv);
  const enc = Buffer.concat([
    cipher.update(JSON.stringify(payload), "utf-8"),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [iv, enc, tag].map((b) => b.toString("base64url")).join(".");
}

export function exchangeAuthorizationCode(
  code: string,
  codeVerifier: string,
  redirectUri: string
): string {
  const parts = code.split(".");
  if (parts.length !== 3) throw new Error("invalid_grant");

  let payload: CodePayload;
  try {
    const iv = Buffer.from(parts[0], "base64url");
    const enc = Buffer.from(parts[1], "base64url");
    const tag = Buffer.from(parts[2], "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", SECRET, iv);
    decipher.setAuthTag(tag);
    const dec = Buffer.concat([decipher.update(enc), decipher.final()]);
    payload = JSON.parse(dec.toString("utf-8"));
  } catch {
    throw new Error("invalid_grant");
  }

  if (Date.now() > payload.exp) throw new Error("invalid_grant");
  if (payload.redirectUri !== redirectUri) throw new Error("invalid_grant");

  const challenge = crypto
    .createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  if (challenge !== payload.codeChallenge) throw new Error("invalid_grant");

  if (!authenticate(payload.apiKey)) throw new Error("invalid_grant");

  return payload.apiKey;
}

function esc(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderAuthorizePage(params: {
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  clientId?: string;
  error?: string;
}): string {
  return `<!DOCTYPE html>
<html lang="nl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Content Server — Inloggen</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,'Segoe UI',system-ui,sans-serif;background:#F5F5F3;color:#1A1A18;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:2rem}
@media(prefers-color-scheme:dark){
  body{background:#141413;color:#E8E7E3}
  .card{background:#1E1E1C;border-color:#333}
  input{background:#252523;border-color:#444;color:#E8E7E3}
  input:focus{border-color:#6EBF70;box-shadow:0 0 0 3px rgba(110,191,112,.15)}
  .error{background:#2A1E14;border-color:#E8863A;color:#E8863A}
  .hint{color:#9A9890}
  .subtitle{color:#9A9890}
}
.card{background:#fff;border:1px solid #E0DFD8;border-radius:12px;padding:2.5rem;max-width:420px;width:100%;box-shadow:0 2px 8px rgba(0,0,0,.06)}
h1{font-size:1.3rem;font-weight:600;margin-bottom:.4rem}
.subtitle{color:#6B6962;font-size:.9rem;margin-bottom:1.5rem}
label{display:block;font-size:.85rem;font-weight:600;margin-bottom:.4rem}
input{width:100%;padding:.7rem .9rem;border:1px solid #D0CFC8;border-radius:6px;font-size:.95rem;font-family:'SF Mono','Fira Code',monospace;margin-bottom:1.2rem;transition:border-color .15s,box-shadow .15s}
input:focus{outline:none;border-color:#2C5F2D;box-shadow:0 0 0 3px rgba(44,95,45,.12)}
button{width:100%;padding:.75rem;background:#2C5F2D;color:#fff;border:none;border-radius:6px;font-size:.95rem;font-weight:600;cursor:pointer;transition:background .15s}
button:hover{background:#245024}
.error{background:#FFF4EC;border-left:3px solid #B84C00;color:#B84C00;padding:.6rem .8rem;border-radius:0 6px 6px 0;margin-bottom:1.2rem;font-size:.88rem}
.hint{color:#6B6962;font-size:.8rem;margin-top:1rem;text-align:center}
</style>
</head>
<body>
<div class="card">
  <h1>MCP Content Server</h1>
  <p class="subtitle">Voer je API key in om toegang te verlenen</p>
  ${params.error ? `<div class="error">${esc(params.error)}</div>` : ""}
  <form method="POST" action="/authorize">
    <input type="hidden" name="redirect_uri" value="${esc(params.redirectUri)}">
    <input type="hidden" name="code_challenge" value="${esc(params.codeChallenge)}">
    <input type="hidden" name="code_challenge_method" value="${esc(params.codeChallengeMethod)}">
    ${params.state ? `<input type="hidden" name="state" value="${esc(params.state)}">` : ""}
    ${params.clientId ? `<input type="hidden" name="client_id" value="${esc(params.clientId)}">` : ""}
    <label for="api_key">API Key</label>
    <input type="password" id="api_key" name="api_key" required autofocus placeholder="Plak hier je API key">
    <button type="submit">Toegang verlenen</button>
  </form>
  <p class="hint">Je key vind je in de installatiehandleiding</p>
</div>
</body>
</html>`;
}

export function getProtectedResourceMetadata(baseUrl: string) {
  return {
    resource: baseUrl,
    authorization_servers: [baseUrl],
    bearer_methods_supported: ["header"],
  };
}

export function getAuthorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/authorize`,
    token_endpoint: `${baseUrl}/token`,
    registration_endpoint: `${baseUrl}/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
  };
}
