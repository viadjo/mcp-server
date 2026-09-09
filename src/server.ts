import crypto from "node:crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { env } from "./env.js";
import { type ApiClient, authenticate } from "./auth.js";
import {
  createAuthorizationCode,
  exchangeAuthorizationCode,
  getAuthorizationServerMetadata,
  getProtectedResourceMetadata,
  renderAuthorizePage,
} from "./oauth.js";
import {
  resolveContext,
  listMarkdownFiles,
  readMarkdownFile,
  createMarkdownFileViaPR,
  updateMarkdownFileViaPR,
  deleteMarkdownFileViaPR,
  mergePR,
  cancelPR,
  listOpenChanges,
  getChangeDetail,
  revertMergedPR,
} from "./github.js";

const repoParam = z
  .string()
  .optional()
  .describe(
    `Override the default repo (default: ${env.githubOwner}/${env.githubRepo}). Format: "owner/repo". Must be in the allowed repos list.`
  );

const contentDirParam = z
  .string()
  .optional()
  .describe(`Override the content directory (default: "${env.contentDir}")`);

const SERVER_VERSION = "0.4.0";

function createMcpServer(client: ApiClient): McpServer {
  const server = new McpServer({
    name: "md-cms-mcp-server",
    version: SERVER_VERSION,
  });

  server.registerTool(
    "get_version",
    {
      title: "Server version",
      description: "Returns the current version of the MCP content server.",
      inputSchema: {},
    },
    async () => ({
      content: [{ type: "text" as const, text: SERVER_VERSION }],
    })
  );

  const prNumberParam = z
    .number()
    .optional()
    .describe(
      "Add this change to an existing wijziging (change number) instead of creating a new one"
    );

  server.registerTool(
    "list_content",
    {
      title: "List content files",
      description:
        "Lists every Markdown (.md) file in the content directory. Returns an array of file paths.",
      inputSchema: {
        repo: repoParam,
        contentDir: contentDirParam,
      },
    },
    async ({ repo, contentDir }) => {
      try {
        const ctx = resolveContext({ repo, contentDir });
        const files = await listMarkdownFiles(ctx);
        return {
          content: [
            { type: "text" as const, text: JSON.stringify(files, null, 2) },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "read_content",
    {
      title: "Read a content file",
      description:
        "Reads the raw Markdown content of a single file (including any YAML frontmatter) from the base branch.",
      inputSchema: {
        path: z.string().describe('File path, e.g. "nl/pages/home.md"'),
        repo: repoParam,
        contentDir: contentDirParam,
      },
    },
    async ({ path, repo, contentDir }) => {
      try {
        const ctx = resolveContext({ repo, contentDir });
        const file = await readMarkdownFile(ctx, path);
        return {
          content: [{ type: "text" as const, text: file.content }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  function requireWrite(): string | null {
    if (client.access !== "readwrite") {
      return "This API key has read-only access. Write operations are not allowed.";
    }
    return null;
  }

  function changeResponse(action: string, result: { path: string; prNumber: number; prUrl: string }): string {
    return `${action}: ${result.path}\nWijziging #${result.prNumber} staat klaar.\n\nVraag de gebruiker: wil je nog iets aanpassen aan deze wijziging, of direct publiceren? Gebruik publish_content met nummer ${result.prNumber} om te publiceren.`;
  }

  server.registerTool(
    "create_content",
    {
      title: "Create a new content file",
      description:
        "Creates a new Markdown file. The change is staged for review — it is not live yet. After creating, show the user the content and ask if they want to publish or make more changes. Requires readwrite access.",
      inputSchema: {
        path: z
          .string()
          .describe('Path for the new file, e.g. "nl/tips/new-article.md"'),
        content: z
          .string()
          .describe("Full Markdown content including YAML frontmatter"),
        commitMessage: z.string().optional().describe("Custom commit message"),
        prTitle: z.string().optional().describe("Title for the change"),
        prNumber: prNumberParam,
        repo: repoParam,
        contentDir: contentDirParam,
      },
    },
    async ({ path, content, commitMessage, prTitle, prNumber, repo, contentDir }) => {
      const denied = requireWrite();
      if (denied)
        return {
          content: [{ type: "text" as const, text: `Error: ${denied}` }],
          isError: true,
        };
      try {
        const ctx = resolveContext({ repo, contentDir });
        const result = await createMarkdownFileViaPR(
          ctx,
          path,
          content,
          client.label,
          { commitMessage, prTitle, prNumber }
        );
        return {
          content: [
            { type: "text" as const, text: changeResponse("Aangemaakt", result) },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "update_content",
    {
      title: "Update a content file",
      description:
        "Replaces the full content of an existing Markdown file. The change is staged for review — it is not live yet. After updating, show the user the new content and ask if they want to publish or make more changes. Requires readwrite access.",
      inputSchema: {
        path: z.string().describe("Path to the existing file"),
        content: z
          .string()
          .describe("Complete new Markdown content for the file"),
        commitMessage: z.string().optional().describe("Custom commit message"),
        prTitle: z.string().optional().describe("Title for the change"),
        prNumber: prNumberParam,
        repo: repoParam,
        contentDir: contentDirParam,
      },
    },
    async ({ path, content, commitMessage, prTitle, prNumber, repo, contentDir }) => {
      const denied = requireWrite();
      if (denied)
        return {
          content: [{ type: "text" as const, text: `Error: ${denied}` }],
          isError: true,
        };
      try {
        const ctx = resolveContext({ repo, contentDir });
        const result = await updateMarkdownFileViaPR(
          ctx,
          path,
          content,
          client.label,
          { commitMessage, prTitle, prNumber }
        );
        return {
          content: [
            { type: "text" as const, text: changeResponse("Gewijzigd", result) },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "delete_content",
    {
      title: "Delete a content file",
      description:
        "Deletes a Markdown file. The deletion is staged for review — it is not live yet. After deleting, ask the user if they want to publish or make more changes. Requires readwrite access.",
      inputSchema: {
        path: z.string().describe("Path to the file to delete"),
        commitMessage: z.string().optional().describe("Custom commit message"),
        prTitle: z.string().optional().describe("Title for the change"),
        prNumber: prNumberParam,
        repo: repoParam,
        contentDir: contentDirParam,
      },
    },
    async ({ path, commitMessage, prTitle, prNumber, repo, contentDir }) => {
      const denied = requireWrite();
      if (denied)
        return {
          content: [{ type: "text" as const, text: `Error: ${denied}` }],
          isError: true,
        };
      try {
        const ctx = resolveContext({ repo, contentDir });
        const result = await deleteMarkdownFileViaPR(
          ctx,
          path,
          client.label,
          { commitMessage, prTitle, prNumber }
        );
        return {
          content: [
            { type: "text" as const, text: changeResponse("Verwijderd", result) },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "publish_content",
    {
      title: "Publish a content change",
      description:
        "Publishes a staged change, making it live on the website. Use this when the user confirms they want to publish. Takes the change number returned by create/update/delete_content.",
      inputSchema: {
        prNumber: z.number().describe("The change number to publish"),
        repo: repoParam,
      },
    },
    async ({ prNumber, repo }) => {
      const denied = requireWrite();
      if (denied)
        return {
          content: [{ type: "text" as const, text: `Error: ${denied}` }],
          isError: true,
        };
      try {
        const ctx = resolveContext({ repo });
        await mergePR(ctx, prNumber);
        return {
          content: [
            {
              type: "text" as const,
              text: `Wijziging #${prNumber} is gepubliceerd en live op de website.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "cancel_content",
    {
      title: "Cancel a content change",
      description:
        "Cancels a staged change so it will not be published. The change is discarded. Use this when the user wants to undo or cancel a pending change.",
      inputSchema: {
        prNumber: z.number().describe("The change number to cancel"),
        repo: repoParam,
      },
    },
    async ({ prNumber, repo }) => {
      const denied = requireWrite();
      if (denied)
        return {
          content: [{ type: "text" as const, text: `Error: ${denied}` }],
          isError: true,
        };
      try {
        const ctx = resolveContext({ repo });
        await cancelPR(ctx, prNumber);
        return {
          content: [
            {
              type: "text" as const,
              text: `Wijziging #${prNumber} is geannuleerd. Er is niets aangepast.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "list_changes",
    {
      title: "List pending changes",
      description:
        "Lists all pending content changes (open pull requests created by this server). Use this to see what is staged before publishing or cancelling. Does not require readwrite access.",
      inputSchema: {
        repo: repoParam,
      },
    },
    async ({ repo }) => {
      try {
        const ctx = resolveContext({ repo });
        const changes = await listOpenChanges(ctx);
        if (changes.length === 0) {
          return {
            content: [
              { type: "text" as const, text: "Er zijn geen openstaande wijzigingen." },
            ],
          };
        }
        const summary = changes
          .map(
            (c) =>
              `#${c.prNumber} — ${c.title} (${c.filesChanged} bestand${c.filesChanged === 1 ? "" : "en"}, ${c.createdAt})`
          )
          .join("\n");
        return {
          content: [{ type: "text" as const, text: summary }],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "read_change",
    {
      title: "Read a pending change",
      description:
        "Shows the files and diffs in a pending content change. Use this to inspect what will be published or to help the user decide whether to publish, modify, or cancel.",
      inputSchema: {
        prNumber: z.number().describe("The change number to inspect"),
        repo: repoParam,
      },
    },
    async ({ prNumber, repo }) => {
      try {
        const ctx = resolveContext({ repo });
        const detail = await getChangeDetail(ctx, prNumber);
        const header = `Wijziging #${detail.prNumber}: ${detail.title}\n${detail.files.length} bestand${detail.files.length === 1 ? "" : "en"} gewijzigd\n`;
        const fileDetails = detail.files
          .map((f) => {
            let line = `${f.status.toUpperCase()} ${f.path} (+${f.additions} -${f.deletions})`;
            if (f.patch) line += `\n\`\`\`diff\n${f.patch}\n\`\`\``;
            return line;
          })
          .join("\n\n");
        return {
          content: [
            { type: "text" as const, text: `${header}\n${fileDetails}` },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  server.registerTool(
    "revert_change",
    {
      title: "Revert a published change",
      description:
        "Reverts a previously published change. Creates a new change that undoes all file modifications from the original publication. The revert is staged for review — use publish_content to make it live. Requires readwrite access.",
      inputSchema: {
        prNumber: z.number().describe("The change number of the published change to revert"),
        repo: repoParam,
      },
    },
    async ({ prNumber, repo }) => {
      const denied = requireWrite();
      if (denied)
        return {
          content: [{ type: "text" as const, text: `Error: ${denied}` }],
          isError: true,
        };
      try {
        const ctx = resolveContext({ repo });
        const result = await revertMergedPR(ctx, prNumber, client.label);
        return {
          content: [
            {
              type: "text" as const,
              text: `Terugdraaiing van wijziging #${prNumber} staat klaar als wijziging #${result.prNumber}.\n\nVraag de gebruiker: wil je de terugdraaiing publiceren? Gebruik publish_content met nummer ${result.prNumber}.`,
            },
          ],
        };
      } catch (err: any) {
        return {
          content: [{ type: "text" as const, text: `Error: ${err.message}` }],
          isError: true,
        };
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.urlencoded({ extended: false }));

function getBaseUrl(req: express.Request): string {
  const proto = req.header("x-forwarded-proto") ?? req.protocol;
  const host = req.header("x-forwarded-host") ?? req.header("host") ?? "localhost";
  return `${proto}://${host}`;
}

const OAUTH_PATHS = ["/authorize", "/token", "/register"];

app.use((req, res, next) => {
  if (
    req.path === "/healthz" ||
    req.path.startsWith("/.well-known/") ||
    OAUTH_PATHS.includes(req.path)
  ) {
    return next();
  }
  const auth = req.header("authorization") ?? "";
  if (!auth.startsWith("Bearer ")) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  const client = authenticate(auth.slice(7));
  if (!client) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  res.locals.client = client;
  next();
});

app.get("/healthz", (_req, res) => res.status(200).send("ok"));

// --- OAuth 2.1 endpoints ---

app.get("/.well-known/oauth-protected-resource", (req, res) => {
  res.json(getProtectedResourceMetadata(getBaseUrl(req)));
});

app.get("/.well-known/oauth-authorization-server", (req, res) => {
  res.json(getAuthorizationServerMetadata(getBaseUrl(req)));
});

app.post("/register", (req, res) => {
  const { client_name, redirect_uris } = req.body;
  res.status(201).json({
    client_id: crypto.randomUUID(),
    client_name: client_name ?? "MCP Client",
    redirect_uris: redirect_uris ?? [],
    grant_types: ["authorization_code"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  });
});

app.get("/authorize", (req, res) => {
  const redirectUri = req.query.redirect_uri as string | undefined;
  const codeChallenge = req.query.code_challenge as string | undefined;
  const codeChallengeMethod = req.query.code_challenge_method as string | undefined;

  if (!redirectUri || !codeChallenge || codeChallengeMethod !== "S256") {
    res.status(400).send("Missing or invalid OAuth parameters");
    return;
  }

  res.type("html").send(
    renderAuthorizePage({
      redirectUri,
      codeChallenge,
      codeChallengeMethod,
      state: req.query.state as string | undefined,
      clientId: req.query.client_id as string | undefined,
    })
  );
});

app.post("/authorize", (req, res) => {
  const { api_key, redirect_uri, code_challenge, code_challenge_method, state, client_id } =
    req.body;

  if (!redirect_uri || !code_challenge || code_challenge_method !== "S256") {
    res.status(400).send("Missing or invalid OAuth parameters");
    return;
  }

  if (!api_key) {
    res.type("html").send(
      renderAuthorizePage({
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        state,
        clientId: client_id,
        error: "Vul je API key in",
      })
    );
    return;
  }

  const client = authenticate(api_key);
  if (!client) {
    res.type("html").send(
      renderAuthorizePage({
        redirectUri: redirect_uri,
        codeChallenge: code_challenge,
        codeChallengeMethod: code_challenge_method,
        state,
        clientId: client_id,
        error: "Ongeldige API key",
      })
    );
    return;
  }

  const code = createAuthorizationCode(api_key, code_challenge, redirect_uri);
  const url = new URL(redirect_uri);
  url.searchParams.set("code", code);
  if (state) url.searchParams.set("state", state);
  res.redirect(302, url.toString());
});

app.post("/token", (req, res) => {
  const { grant_type, code, code_verifier, redirect_uri } = req.body;

  if (grant_type !== "authorization_code") {
    res.status(400).json({ error: "unsupported_grant_type" });
    return;
  }

  if (!code || !code_verifier || !redirect_uri) {
    res.status(400).json({ error: "invalid_request" });
    return;
  }

  try {
    const accessToken = exchangeAuthorizationCode(code, code_verifier, redirect_uri);
    res.json({
      access_token: accessToken,
      token_type: "Bearer",
    });
  } catch {
    res.status(400).json({ error: "invalid_grant" });
  }
});

app.post("/mcp", async (req, res) => {
  try {
    const client = res.locals.client as ApiClient;
    const server = createMcpServer(client);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

app.get("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});
app.delete("/mcp", (_req, res) => {
  res.status(405).json({ error: "Method not allowed (stateless server)" });
});

export default app;

if (!process.env.VERCEL) {
  app.listen(env.port, () => {
    console.log(`md-cms-mcp-server listening on port ${env.port}`);
    console.log(
      `Default repo: ${env.githubOwner}/${env.githubRepo} (${env.baseBranch})`
    );
    console.log(`Allowed repos: ${[...env.allowedRepos].join(", ")}`);
    console.log(`Content dir: ${env.contentDir}`);
  });
}
