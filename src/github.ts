import { Octokit } from "@octokit/rest";
import * as path from "node:path";
import { env } from "./env.js";

const octokit = new Octokit({ auth: env.githubToken });

export interface RepoContext {
  owner: string;
  repo: string;
  contentDir: string;
  baseBranch: string;
}

export function resolveContext(overrides?: {
  repo?: string;
  contentDir?: string;
}): RepoContext {
  const ctx: RepoContext = {
    owner: env.githubOwner,
    repo: env.githubRepo,
    contentDir: env.contentDir,
    baseBranch: env.baseBranch,
  };
  if (overrides?.repo) {
    const parts = overrides.repo.split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new Error(
        `Invalid repo format "${overrides.repo}", expected "owner/repo"`
      );
    }
    ctx.owner = parts[0];
    ctx.repo = parts[1];
  }
  if (overrides?.contentDir !== undefined) {
    ctx.contentDir = overrides.contentDir;
  }

  const repoKey = `${ctx.owner}/${ctx.repo}`.toLowerCase();
  if (!env.allowedRepos.has(repoKey)) {
    throw new Error(
      `Repository ${ctx.owner}/${ctx.repo} is not in the allowed list`
    );
  }

  return ctx;
}

function normalizePath(rawPath: string, contentDir: string): string {
  const cleaned = rawPath.replace(/^\/+/, "");
  const normalized = path.posix.normalize(cleaned);

  if (normalized.split("/").includes("..")) {
    throw new Error("Path traversal is not allowed");
  }

  const prefix = contentDir.replace(/^\/+|\/+$/g, "");
  if (!prefix) return normalized;
  if (normalized === prefix || normalized.startsWith(`${prefix}/`)) {
    return normalized;
  }
  return `${prefix}/${normalized}`;
}

export async function listMarkdownFiles(ctx: RepoContext): Promise<string[]> {
  const { data: branch } = await octokit.repos.getBranch({
    owner: ctx.owner,
    repo: ctx.repo,
    branch: ctx.baseBranch,
  });

  const { data: tree } = await octokit.git.getTree({
    owner: ctx.owner,
    repo: ctx.repo,
    tree_sha: branch.commit.sha,
    recursive: "true",
  });

  const prefix = ctx.contentDir.replace(/^\/+|\/+$/g, "");
  return tree.tree
    .filter((item) => {
      if (item.type !== "blob" || !item.path?.endsWith(".md")) return false;
      if (!prefix) return true;
      return item.path.startsWith(`${prefix}/`);
    })
    .map((item) => item.path as string)
    .sort();
}

export async function readMarkdownFile(
  ctx: RepoContext,
  filePath: string
): Promise<{ path: string; content: string }> {
  const fullPath = normalizePath(filePath, ctx.contentDir);

  const { data } = await octokit.repos.getContent({
    owner: ctx.owner,
    repo: ctx.repo,
    path: fullPath,
    ref: ctx.baseBranch,
  });

  if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
    throw new Error(`${fullPath} is not a readable file`);
  }

  return {
    path: fullPath,
    content: Buffer.from(data.content, "base64").toString("utf-8"),
  };
}

function slugify(str: string): string {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9/]+/g, "-")
    .replace(/\/+/g, "-")
    .replace(/(^-|-$)/g, "");
}

async function createBranch(
  ctx: RepoContext,
  filePath: string,
  action: string
): Promise<string> {
  const { data: baseRef } = await octokit.git.getRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `heads/${ctx.baseBranch}`,
  });

  const branch = `cms-${action}/${slugify(filePath)}-${Date.now()}`;
  await octokit.git.createRef({
    owner: ctx.owner,
    repo: ctx.repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.object.sha,
  });

  return branch;
}

async function openPR(
  ctx: RepoContext,
  branch: string,
  title: string,
  body: string
): Promise<{ prUrl: string; prNumber: number }> {
  const { data: pr } = await octokit.pulls.create({
    owner: ctx.owner,
    repo: ctx.repo,
    base: ctx.baseBranch,
    head: branch,
    title,
    body,
  });
  return { prUrl: pr.html_url, prNumber: pr.number };
}

export interface ChangeResult {
  path: string;
  branch: string;
  prUrl: string;
  prNumber: number;
}

function prBody(description: string, clientLabel: string): string {
  return `${description}\n\n---\nRequested by: **${clientLabel}** (via MCP content server)`;
}

async function resolveBranch(
  ctx: RepoContext,
  filePath: string,
  action: string,
  prNumber?: number
): Promise<{ branch: string; existingPR?: { url: string; number: number } }> {
  if (prNumber) {
    const { data: pr } = await octokit.pulls.get({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: prNumber,
    });
    if (pr.state !== "open") {
      throw new Error(`Wijziging #${prNumber} is al gesloten`);
    }
    return {
      branch: pr.head.ref,
      existingPR: { url: pr.html_url, number: prNumber },
    };
  }
  return { branch: await createBranch(ctx, filePath, action) };
}

export async function createMarkdownFileViaPR(
  ctx: RepoContext,
  filePath: string,
  content: string,
  clientLabel: string,
  opts: { commitMessage?: string; prTitle?: string; prNumber?: number } = {}
): Promise<ChangeResult> {
  const fullPath = normalizePath(filePath, ctx.contentDir);

  if (!fullPath.endsWith(".md")) {
    throw new Error("Only .md files can be created");
  }

  try {
    await octokit.repos.getContent({
      owner: ctx.owner,
      repo: ctx.repo,
      path: fullPath,
      ref: ctx.baseBranch,
    });
    throw new Error(
      `File already exists: ${fullPath}. Use update_content to modify it.`
    );
  } catch (err: any) {
    if (err.status !== 404) throw err;
  }

  const { branch, existingPR } = await resolveBranch(
    ctx, fullPath, "create", opts.prNumber
  );
  const commitMessage =
    opts.commitMessage ?? `Create ${fullPath} via MCP content server`;

  await octokit.repos.createOrUpdateFileContents({
    owner: ctx.owner,
    repo: ctx.repo,
    path: fullPath,
    branch,
    message: commitMessage,
    content: Buffer.from(content, "utf-8").toString("base64"),
  });

  if (existingPR) {
    return { path: fullPath, branch, prUrl: existingPR.url, prNumber: existingPR.number };
  }

  const { prUrl, prNumber } = await openPR(
    ctx,
    branch,
    opts.prTitle ?? commitMessage,
    prBody(`New content file \`${fullPath}\`.`, clientLabel)
  );

  return { path: fullPath, branch, prUrl, prNumber };
}

export async function updateMarkdownFileViaPR(
  ctx: RepoContext,
  filePath: string,
  content: string,
  clientLabel: string,
  opts: { commitMessage?: string; prTitle?: string; prNumber?: number } = {}
): Promise<ChangeResult> {
  const fullPath = normalizePath(filePath, ctx.contentDir);

  const { branch, existingPR } = await resolveBranch(
    ctx, fullPath, "edit", opts.prNumber
  );

  const { data: existing } = await octokit.repos.getContent({
    owner: ctx.owner,
    repo: ctx.repo,
    path: fullPath,
    ref: branch,
  });

  if (Array.isArray(existing) || existing.type !== "file") {
    throw new Error(`${fullPath} is not a file`);
  }

  const commitMessage =
    opts.commitMessage ?? `Update ${fullPath} via MCP content server`;

  await octokit.repos.createOrUpdateFileContents({
    owner: ctx.owner,
    repo: ctx.repo,
    path: fullPath,
    branch,
    message: commitMessage,
    content: Buffer.from(content, "utf-8").toString("base64"),
    sha: existing.sha,
  });

  if (existingPR) {
    return { path: fullPath, branch, prUrl: existingPR.url, prNumber: existingPR.number };
  }

  const { prUrl, prNumber } = await openPR(
    ctx,
    branch,
    opts.prTitle ?? commitMessage,
    prBody(`Content edit for \`${fullPath}\`.`, clientLabel)
  );

  return { path: fullPath, branch, prUrl, prNumber };
}

export async function deleteMarkdownFileViaPR(
  ctx: RepoContext,
  filePath: string,
  clientLabel: string,
  opts: { commitMessage?: string; prTitle?: string; prNumber?: number } = {}
): Promise<ChangeResult> {
  const fullPath = normalizePath(filePath, ctx.contentDir);

  const { branch, existingPR } = await resolveBranch(
    ctx, fullPath, "delete", opts.prNumber
  );

  const { data: existing } = await octokit.repos.getContent({
    owner: ctx.owner,
    repo: ctx.repo,
    path: fullPath,
    ref: branch,
  });

  if (Array.isArray(existing) || existing.type !== "file") {
    throw new Error(`${fullPath} is not a file`);
  }

  const commitMessage =
    opts.commitMessage ?? `Delete ${fullPath} via MCP content server`;

  await octokit.repos.deleteFile({
    owner: ctx.owner,
    repo: ctx.repo,
    path: fullPath,
    branch,
    message: commitMessage,
    sha: existing.sha,
  });

  if (existingPR) {
    return { path: fullPath, branch, prUrl: existingPR.url, prNumber: existingPR.number };
  }

  const { prUrl, prNumber } = await openPR(
    ctx,
    branch,
    opts.prTitle ?? commitMessage,
    prBody(`Delete \`${fullPath}\`.`, clientLabel)
  );

  return { path: fullPath, branch, prUrl, prNumber };
}

export async function mergePR(
  ctx: RepoContext,
  prNumber: number
): Promise<{ prUrl: string }> {
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
  });

  if (pr.state !== "open") {
    throw new Error(`Wijziging #${prNumber} is al ${pr.merged ? "gepubliceerd" : "gesloten"}`);
  }

  await octokit.pulls.merge({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
    merge_method: "squash",
  });

  try {
    await octokit.git.deleteRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `heads/${pr.head.ref}`,
    });
  } catch {
    // branch may already be gone
  }

  return { prUrl: pr.html_url };
}

export async function cancelPR(
  ctx: RepoContext,
  prNumber: number
): Promise<{ prUrl: string }> {
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
  });

  if (pr.state !== "open") {
    throw new Error(`Wijziging #${prNumber} is al ${pr.merged ? "gepubliceerd" : "geannuleerd"}`);
  }

  await octokit.pulls.update({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
    state: "closed",
  });

  try {
    await octokit.git.deleteRef({
      owner: ctx.owner,
      repo: ctx.repo,
      ref: `heads/${pr.head.ref}`,
    });
  } catch {
    // branch may already be gone
  }

  return { prUrl: pr.html_url };
}

export async function revertMergedPR(
  ctx: RepoContext,
  prNumber: number,
  clientLabel: string
): Promise<ChangeResult> {
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
  });

  if (!pr.merged) {
    throw new Error(
      pr.state === "open"
        ? `Wijziging #${prNumber} is nog niet gepubliceerd. Gebruik cancel_content om te annuleren.`
        : `Wijziging #${prNumber} is geannuleerd (nooit gepubliceerd), er valt niets terug te draaien.`
    );
  }

  const { data: files } = await octokit.pulls.listFiles({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  const mergeCommitSha = pr.merge_commit_sha;
  if (!mergeCommitSha) {
    throw new Error("Kan de merge-commit niet vinden");
  }

  const { data: mergeCommit } = await octokit.git.getCommit({
    owner: ctx.owner,
    repo: ctx.repo,
    commit_sha: mergeCommitSha,
  });
  const parentSha = mergeCommit.parents[0].sha;

  const branch = await createBranch(ctx, `revert-${prNumber}`, "revert");

  for (const file of files) {
    if (file.status === "added") {
      const { data: current } = await octokit.repos.getContent({
        owner: ctx.owner,
        repo: ctx.repo,
        path: file.filename,
        ref: branch,
      });
      if (!Array.isArray(current) && current.type === "file") {
        await octokit.repos.deleteFile({
          owner: ctx.owner,
          repo: ctx.repo,
          path: file.filename,
          branch,
          message: `Revert: delete ${file.filename}`,
          sha: current.sha,
        });
      }
    } else if (file.status === "removed") {
      const { data: old } = await octokit.repos.getContent({
        owner: ctx.owner,
        repo: ctx.repo,
        path: file.filename,
        ref: parentSha,
      });
      if (!Array.isArray(old) && old.type === "file" && "content" in old) {
        await octokit.repos.createOrUpdateFileContents({
          owner: ctx.owner,
          repo: ctx.repo,
          path: file.filename,
          branch,
          message: `Revert: restore ${file.filename}`,
          content: old.content.replace(/\n/g, ""),
        });
      }
    } else {
      const { data: old } = await octokit.repos.getContent({
        owner: ctx.owner,
        repo: ctx.repo,
        path: file.filename,
        ref: parentSha,
      });
      const { data: current } = await octokit.repos.getContent({
        owner: ctx.owner,
        repo: ctx.repo,
        path: file.filename,
        ref: branch,
      });
      if (
        !Array.isArray(old) && old.type === "file" && "content" in old &&
        !Array.isArray(current) && current.type === "file"
      ) {
        await octokit.repos.createOrUpdateFileContents({
          owner: ctx.owner,
          repo: ctx.repo,
          path: file.filename,
          branch,
          message: `Revert: restore ${file.filename}`,
          content: old.content.replace(/\n/g, ""),
          sha: current.sha,
        });
      }
    }
  }

  const { prUrl, prNumber: revertPrNumber } = await openPR(
    ctx,
    branch,
    `Revert: ${pr.title}`,
    prBody(`Reverts wijziging #${prNumber} (${pr.title}).`, clientLabel)
  );

  return { path: `revert-${prNumber}`, branch, prUrl, prNumber: revertPrNumber };
}

export interface ChangeSummary {
  prNumber: number;
  title: string;
  createdAt: string;
  filesChanged: number;
  url: string;
}

export async function listOpenChanges(
  ctx: RepoContext
): Promise<ChangeSummary[]> {
  const { data: prs } = await octokit.pulls.list({
    owner: ctx.owner,
    repo: ctx.repo,
    state: "open",
    base: ctx.baseBranch,
    per_page: 50,
    sort: "created",
    direction: "desc",
  });

  const mcpPRs = prs.filter(
    (pr) => pr.head.ref.startsWith("cms-") && pr.body?.includes("via MCP content server")
  );

  const results: ChangeSummary[] = [];
  for (const pr of mcpPRs) {
    const { data: files } = await octokit.pulls.listFiles({
      owner: ctx.owner,
      repo: ctx.repo,
      pull_number: pr.number,
      per_page: 100,
    });
    results.push({
      prNumber: pr.number,
      title: pr.title,
      createdAt: pr.created_at,
      filesChanged: files.length,
      url: pr.html_url,
    });
  }

  return results;
}

export interface ChangeDetail {
  prNumber: number;
  title: string;
  createdAt: string;
  url: string;
  files: Array<{
    path: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
}

export async function getChangeDetail(
  ctx: RepoContext,
  prNumber: number
): Promise<ChangeDetail> {
  const { data: pr } = await octokit.pulls.get({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
  });

  const { data: files } = await octokit.pulls.listFiles({
    owner: ctx.owner,
    repo: ctx.repo,
    pull_number: prNumber,
    per_page: 100,
  });

  return {
    prNumber: pr.number,
    title: pr.title,
    createdAt: pr.created_at,
    url: pr.html_url,
    files: files.map((f) => ({
      path: f.filename,
      status: f.status,
      additions: f.additions,
      deletions: f.deletions,
      patch: f.patch,
    })),
  };
}
