import { loadKeys } from "./auth.js";

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

function parseAllowedRepos(): Set<string> {
  const defaultRepo = `${required("GITHUB_OWNER")}/${required("GITHUB_REPO")}`;
  const raw = process.env.ALLOWED_REPOS;
  if (!raw) return new Set([defaultRepo.toLowerCase()]);
  const repos = raw
    .split(",")
    .map((r) => r.trim().toLowerCase())
    .filter(Boolean);
  if (!repos.includes(defaultRepo.toLowerCase())) {
    repos.push(defaultRepo.toLowerCase());
  }
  return new Set(repos);
}

loadKeys();

export const env = {
  githubToken: required("GITHUB_TOKEN"),
  githubOwner: required("GITHUB_OWNER"),
  githubRepo: required("GITHUB_REPO"),
  contentDir: process.env.CONTENT_DIR ?? "content",
  baseBranch: process.env.BASE_BRANCH ?? "main",
  allowedRepos: parseAllowedRepos(),
  port: Number(process.env.PORT ?? 3000),
};
