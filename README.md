# md-cms-mcp-server

MCP-server die een AI-assistent (Claude, ChatGPT) vijf tools geeft om
Markdown-content in een GitHub-repo te beheren, als een headless CMS:

- `list_content` — lijst alle `.md`-bestanden in de content-directory.
- `read_content` — leest de ruwe inhoud (incl. frontmatter) van één bestand.
- `create_content` — maakt een nieuw `.md`-bestand aan via branch + PR.
- `update_content` — vervangt de inhoud van een bestaand bestand via branch + PR.
- `delete_content` — verwijdert een bestand via branch + PR.

Alle schrijfoperaties gaan **altijd via een branch + pull request** — er wordt
nooit direct naar de base branch geschreven, zodat wijzigingen reviewbaar zijn.

De server is **multi-repo**: standaard werkt hij met de repo uit de env-vars,
maar elke tool accepteert een optioneel `repo`-parameter (`"owner/repo"`) om
een andere repo te beheren. De GitHub-token moet dan wel toegang hebben tot
die repo.

De server draait stateless over Streamable HTTP (één `/mcp`-endpoint), zodat
hij als custom connector in zowel Claude als ChatGPT werkt.

## 1. Lokaal testen

```bash
npm install
cp .env.example .env   # vul GITHUB_TOKEN, GITHUB_OWNER, GITHUB_REPO, MCP_ACCESS_TOKEN in
npm run dev
```

Health check: `curl http://localhost:3000/healthz` → `ok`.

Test met de [MCP Inspector](https://github.com/modelcontextprotocol/inspector)
of voeg de server direct als connector toe aan Claude Desktop.

## 2. GitHub token aanmaken

Maak een **fine-grained personal access token** aan
(GitHub → Settings → Developer settings → Fine-grained tokens), scoped tot
de repo('s) die je wilt beheren, met permissies:

- Contents: **Read and write**
- Pull requests: **Read and write**

Voor multi-repo: scope de token naar alle repo's die je wilt beheren.

## 3. Deployen

De server is een gewone Node/Express-app:

```bash
docker build -t md-cms-mcp-server .
docker run -p 3000:3000 --env-file .env md-cms-mcp-server
```

Past op elk platform met Dockerfile of Node-buildpack support
(Render, Fly.io, Railway, VPS). Zorg dat de server bereikbaar is via
**https** — MCP-clients accepteren doorgaans geen http-only servers.

## 4. Koppelen aan Claude

In claude.ai: **Settings → Connectors → Add custom connector**.
- URL: `https://jouw-domein.tld/mcp`
- Header: `Authorization: Bearer <jouw MCP_ACCESS_TOKEN>`

In Claude Desktop/Claude Code:

```json
{
  "mcpServers": {
    "md-cms": {
      "type": "http",
      "url": "https://jouw-domein.tld/mcp",
      "headers": {
        "Authorization": "Bearer <jouw MCP_ACCESS_TOKEN>"
      }
    }
  }
}
```

## 5. Koppelen aan ChatGPT

Onder **Settings → Connectors** voeg je dezelfde URL en
Authorization-header toe.

## Ontwerpkeuzes

- **Altijd via branch + PR**, nooit direct commit naar de base branch.
- **Eén gedeeld bearer-token** voor alle clients.
- **CONTENT_DIR-sandboxing**: alle paths worden genormaliseerd en gedwongen
  binnen de content-directory te blijven.
- **Multi-repo**: env-vars zetten de standaard-repo, maar tools accepteren
  een `repo`-override. De token-scope is de security-boundary.
