import { timingSafeEqual } from "node:crypto";

export interface ApiClient {
  label: string;
  access: "read" | "readwrite";
}

interface StoredKey {
  label: string;
  key: string;
  access: "read" | "readwrite";
}

let keys: StoredKey[] = [];

export function loadKeys(): void {
  const json = process.env.MCP_API_KEYS;
  if (json) {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      throw new Error("MCP_API_KEYS must be a non-empty JSON array");
    }
    for (const k of parsed) {
      if (!k.label || !k.key || !["read", "readwrite"].includes(k.access)) {
        throw new Error(
          `Invalid API key entry: each needs {label, key, access: "read"|"readwrite"}`
        );
      }
    }
    keys = parsed;
    return;
  }

  const legacy = process.env.MCP_ACCESS_TOKEN;
  if (legacy) {
    keys = [{ label: "default", key: legacy, access: "readwrite" }];
    return;
  }

  throw new Error(
    "Set MCP_API_KEYS (JSON array) or MCP_ACCESS_TOKEN (single key, backwards compat)"
  );
}

export function authenticate(bearerToken: string): ApiClient | null {
  const tokenBuf = Buffer.from(bearerToken, "utf-8");

  for (const entry of keys) {
    const keyBuf = Buffer.from(entry.key, "utf-8");
    if (
      tokenBuf.length === keyBuf.length &&
      timingSafeEqual(tokenBuf, keyBuf)
    ) {
      return { label: entry.label, access: entry.access };
    }
  }

  return null;
}
