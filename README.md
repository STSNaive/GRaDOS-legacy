# GRaDOS

[English](./README.md) | [简体中文](./README.zh-CN.md)

<div align="center">
  <pre style="display:inline-block; margin:0; font-family:'Bitstream Vera Sans Mono', 'SF Mono', Consolas, monospace; font-size:15px; line-height:1.02; font-weight:bold; white-space:pre; text-align:left;">&nbsp;&nbsp;.oooooo.&nbsp;&nbsp;&nbsp;&nbsp;ooooooooo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;oooooooooo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.oooooo.&nbsp;&nbsp;&nbsp;&nbsp;.oooooo..o
&nbsp;d8P'&nbsp;&nbsp;`Y8b&nbsp;&nbsp;&nbsp;`888&nbsp;&nbsp;&nbsp;`Y88.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`888'&nbsp;&nbsp;&nbsp;`Y8b&nbsp;&nbsp;&nbsp;d8P'&nbsp;&nbsp;`Y8b&nbsp;&nbsp;d8P'&nbsp;&nbsp;&nbsp;&nbsp;`Y8
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;.d88'&nbsp;&nbsp;.oooo.&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;Y88bo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888ooo88P'&nbsp;&nbsp;`P&nbsp;&nbsp;)88b&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;`"Y8888o.&nbsp;
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ooooo&nbsp;&nbsp;888`88b.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.oP"888&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`"Y88b
`88.&nbsp;&nbsp;&nbsp;&nbsp;.88'&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;`88b.&nbsp;&nbsp;d8(&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;d88'&nbsp;`88b&nbsp;&nbsp;&nbsp;&nbsp;d88'&nbsp;oo&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.d8P
&nbsp;`Y8bood8P'&nbsp;&nbsp;&nbsp;o888o&nbsp;&nbsp;o888o&nbsp;`Y888""8o&nbsp;o888bood8P'&nbsp;&nbsp;&nbsp;&nbsp;`Y8bood8P'&nbsp;&nbsp;8""88888P'&nbsp;</pre>
</div>

<p align="center">
  <strong style="font-size:1.75rem;">Graduate Research and Document Operating System</strong>
</p>

The enrichment-grade MCP server for academic paper search and full-text extraction. For science.

GRaDOS gives AI agents (Claude, Codex, etc.) the ability to search academic databases, download full-text papers through paywalls, and synthesize citation-grounded answers. It is designed for campus network environments where institutional access provides database permissions.

## Architecture 🧭

GRaDOS is designed to sit inside an agent workflow:

1. Check a local paper library first when paired with `mcp-local-rag`
2. Search remote academic sources in configured priority order
3. Fetch full text with a waterfall: `TDM -> OA -> Sci-Hub -> Headless`
4. Parse PDFs with `LlamaParse -> Marker -> Native`
5. Run QA checks before returning content
6. Save raw PDFs to `downloads/` and parsed Markdown to `papers/` for later reuse

### MCP Tools 🔧

| Server | Tool | Description |
|---|---|---|
| GRaDOS | `search_academic_papers` | Waterfall search across Scopus, Web of Science, Springer, Crossref, and PubMed. Deduplicates by DOI. |
| GRaDOS | `extract_paper_full_text` | 4-stage fetch + 3-stage parse + QA validation. Returns Markdown and auto-saves `.md` to the papers directory. |
| GRaDOS | `parse_pdf_file` | Parse a local PDF via configured waterfall (LlamaParse → Marker → Native). Use after downloading PDFs with Playwright MCP. |
| GRaDOS | `save_paper_to_zotero` | Saves cited paper metadata to Zotero web library via API. Called after synthesis for papers used in the answer. |
| mcp-local-rag | `query_documents` | Semantic + keyword search over locally indexed papers. |
| mcp-local-rag | `ingest_file` | Index a paper's Markdown file into the local RAG database. |
| mcp-local-rag | `list_files` | List all indexed papers with status. |
| mcp-local-rag | `delete_file` | Remove stale indexed entries from the local RAG database. |
| mcp-local-rag | `status` | Inspect local RAG database health and configuration warnings. |

### SKILL.md (Companion Skill) 🤖

`skills/grados/SKILL.md` is the companion structured prompt that describes the research workflow around GRaDOS and `mcp-local-rag`. Copy it into your agent's skill/prompt directory to enable the full workflow.

### Local Paper Knowledge Base 🗂️

After extracting a paper, GRaDOS stores the PDF and the parsed Markdown separately to prevent duplicate indexing:

| Directory | Content | Purpose | Configured by |
|---|---|---|---|
| `downloads/` | Raw `.pdf` files | Archival only, not indexed | `extract.downloadDirectory` |
| `papers/` | Parsed `.md` files (with YAML front-matter) | Available for semantic and keyword retrieval | `extract.papersDirectory` |

Each Markdown file includes structured front-matter:

```yaml
---
doi: "10.1038/s41598-025-29656-1"
title: "Triple-negative complementary metamaterial..."
source: "Unpaywall OA"
fetched_at: "2026-03-17T12:00:00.000Z"
---
```

Pair with [`mcp-local-rag`](https://github.com/shinpr/mcp-local-rag) to build a vector index over `papers/` for local semantic and keyword retrieval. The full workflow:

1. **Extract** - GRaDOS downloads a PDF and parses it, saves `.pdf` to `downloads/` and `.md` to `papers/`
2. **Ingest** - The AI agent calls `ingest_file` on the new `.md` file, which embeds it into a local LanceDB vector store
3. **Query** - On future questions, the workflow can check the local library first via `query_documents`, avoiding redundant API calls and re-extraction
4. **Manage** - Use `list_files` to see all indexed papers and `delete_file` to remove outdated entries

> **Note:** `mcp-local-rag` does not auto-scan directories. Papers must be explicitly ingested via the `ingest_file` tool. The included `SKILL.md` workflow can handle this automatically.

## Installation 🚀

### Option A: Claude Code Plugin (easiest) 🔌

If you use [Claude Code](https://code.claude.com/) (CLI or Desktop), install GRaDOS as a plugin. This automatically registers all three MCP servers (GRaDOS, mcp-local-rag, Playwright) with no manual configuration.

**1. Add the marketplace and install:**

```bash
# In Claude Code
/plugin marketplace add STSNaive/GRaDOS
/plugin install grados@stsnaive-grados
```

**2. Run the setup command:**

```
/grados:setup
```

This generates a config file and guides you through setting API keys. No environment variables or shell profile editing required — the plugin handles all paths automatically.

**3. Reload and verify:**

```
/reload-plugins
/grados:status
```

> **What the plugin includes:** GRaDOS MCP server, [mcp-local-rag](https://github.com/shinpr/mcp-local-rag) for local paper retrieval, [Playwright MCP](https://github.com/microsoft/playwright-mcp) for browser-assisted PDF downloads, a research workflow skill, and setup/status commands.

### Option B: npm (manual setup) 📦

```bash
npm install -g grados

# Generate config file in your working directory
grados --init

# Edit the config with your API keys
# (see mcp-config.example.json for all options)
```

### Option C: From source 🛠️

```bash
git clone https://github.com/STSNaive/GRaDOS.git
cd GRaDOS
npm install
npm run build

cp mcp-config.example.json mcp-config.json
# Edit mcp-config.json with your API keys
```

### Configure your MCP client 🔌

**Claude Code:**

```bash
claude mcp add --transport stdio grados -- npx -y grados
```

**Codex:**

```bash
codex mcp add grados -- npx -y grados
```

If you want GRaDOS to load a specific `mcp-config.json`, use `--config` (recommended) or `GRADOS_CONFIG_PATH`:

Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "/path/to/mcp-config.json"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados", "--config", "/path/to/mcp-config.json"]
```

### Optional: Install Marker (high-quality local PDF parsing) 🧠

Marker uses deep learning models to convert PDFs to Markdown with much better accuracy than the built-in parser (`pdf-parse`). It is the recommended parser for production use.

> **Path behavior:** Marker is resolved from `marker-worker/` inside the grados package installation directory (`PACKAGE_ROOT`), not from `cwd` or the config directory. When installed via `npm install -g grados`, it is automatically found at the correct location.

**Prerequisites:** Python 3.12 (required by `marker-pdf`). Optional: NVIDIA GPU + CUDA for significant speedup.

**Install:**

```powershell
cd marker-worker
.\install.ps1              # Auto-detect CPU/GPU
.\install.ps1 -Torch cuda  # Force GPU (CUDA)
.\install.ps1 -Torch cpu   # Force CPU
```

The install script will:
1. Set up a Python 3.12 virtual environment (via `uv`)
2. Install Marker and the selected PyTorch backend
3. Download model weights and fonts to `marker-worker/.cache/` (first run only)

**Enable in config:** After installation, update `mcp-config.json` to enable Marker:

```json
{
  "extract": {
    "parsing": {
      "markerTimeout": 120000,
      "order": ["Marker", "Native"],
      "enabled": {
        "LlamaParse": false,
        "Marker": true,
        "Native": true
      }
    }
  }
}
```

Marker is part of the progressive parsing waterfall: if it fails or times out, GRaDOS automatically falls back to `Native` (`pdf-parse`). The `markerTimeout` setting (milliseconds) controls how long to wait before falling back (default: 120 seconds).

**Verify:** Run the smoke test to confirm Marker is working:

```bash
node tests/mcp-smoke.mjs
```

If Marker is active, the log will show:

```text
[Marker] Converting PDF with local Marker worker...
Marker successfully converted PDF to Markdown.
```

### Optional: Install mcp-local-rag (local paper library with RAG) 🔎

[mcp-local-rag](https://github.com/shinpr/mcp-local-rag) provides semantic and keyword retrieval for local papers. Pure Node.js, no Python required.

> **Version note:** the current `mcp-local-rag` 0.10.x line requires Node.js 20 or newer.

**Register with your MCP client:**

```bash
# Claude Code
claude mcp add local-rag -- npx -y mcp-local-rag

# Codex (set BASE_DIR explicitly)
codex mcp add local-rag --env BASE_DIR=/absolute/path/to/papers -- npx -y mcp-local-rag
```

For Claude Code, the manual config below is the clearest way to ensure `BASE_DIR` matches your `papers` directory.

Or configure manually - Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados"],
      "cwd": "/path/to/project-or-config-directory"
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/absolute/path/to/papers"
      }
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
cwd = "/path/to/project-or-config-directory"

[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]
env = { BASE_DIR = "/absolute/path/to/papers" }
```

> **Important:** `BASE_DIR` must point to the same absolute directory as `extract.papersDirectory` in `mcp-config.json`. If `extract.papersDirectory` is relative, resolve it from `PROJECT_ROOT` first (usually the config file's directory).


### Optional: Zotero web library integration 📚

GRaDOS can automatically save cited papers to your [Zotero](https://www.zotero.org/) web library after each research session. No desktop client is required - it uses the Zotero Web API directly.

**Setup:**

1. Get your **API key** at `https://www.zotero.org/settings/keys` -> New Key -> check "Write Access".
2. Get your **library ID** (numeric user ID shown on the same page as "Your userID for use in API calls").
3. Add both to `mcp-config.json`:

```json
{
  "zotero": {
    "libraryId": "1234567",
    "libraryType": "user",
    "defaultCollectionKey": ""
  },
  "apiKeys": {
    "ZOTERO_API_KEY": "your-api-key-here"
  }
}
```

Papers are saved as `journalArticle` items with title, DOI, authors, abstract, journal, year, URL, and tags. The research query topic is automatically added as a tag to keep your library organised by theme.

### Optional: Playwright MCP (LLM-friendly browser fallback) 🌐

When GRaDOS's built-in headless browser (Puppeteer) fails to extract a PDF — typically due to complex publisher page layouts or CAPTCHA challenges — the AI agent can fall back to [Playwright MCP](https://github.com/microsoft/playwright-mcp), which gives the LLM direct browser control through accessibility tree snapshots.

**Why Playwright MCP over raw Puppeteer?** Puppeteer uses hardcoded CSS selectors that break on unfamiliar publisher pages. With Playwright MCP, the LLM sees the page structure and can adaptively click the right download button, regardless of layout. This is token-expensive (~13.7K base + page content), so it's only used as a fallback when the zero-cost Puppeteer path fails.

**Install:**

```bash
npm install -g @playwright/mcp
```

**Register with your MCP client:**

```bash
# Claude Code
claude mcp add playwright -- npx @playwright/mcp --headless

# Codex
codex mcp add playwright -- npx @playwright/mcp --headless
```

Or configure manually — Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"]
    }
  }
}
```

The `SKILL.md` workflow (Step 3b) automatically guides the agent to use Playwright MCP tools when `extract_paper_full_text` fails. The workflow is: `browser_navigate` → `browser_snapshot` → `browser_click` → download → `parse_pdf_file`.

> **Note:** Playwright MCP is entirely optional. Without it, GRaDOS still works through its built-in waterfall (TDM → OA → Sci-Hub → Headless Puppeteer). Playwright MCP adds an LLM-driven safety net for the cases Puppeteer can't handle.

### Configuration Example: GRaDOS + mcp-local-rag + Playwright 🧩

If you want to wire up the most common end-to-end research workflow in one shot, configure these three MCP services together. This example assumes your config file lives at `D:/Projects/Papers/mcp-config.json`, and that `extract.papersDirectory` uses the default relative path `./papers`, so `mcp-local-rag` should point `BASE_DIR` to `D:/Projects/Papers/papers`.

Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "D:/Projects/Papers/mcp-config.json"]
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "D:/Projects/Papers/papers"
      }
    },
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp", "--headless"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados", "--config", "D:/Projects/Papers/mcp-config.json"]

[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]
env = { BASE_DIR = "D:/Projects/Papers/papers" }

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp", "--headless"]
```

## Configuration ⚙️

All configuration lives in a single file: `mcp-config.json`. Run `grados --init` to generate one from the template.

### API Keys 🔑

| Key | Source | Required | Free |
|---|---|---|---|
| `ELSEVIER_API_KEY` | [Elsevier Developer Portal](https://dev.elsevier.com/) | No | Yes (institutional) |
| `WOS_API_KEY` | [Clarivate Developer Portal](https://developer.clarivate.com/) | No | Yes (starter) |
| `SPRINGER_meta_API_KEY` | [Springer Nature API](https://dev.springernature.com/) | No | Yes |
| `SPRINGER_OA_API_KEY` | Same as above (OpenAccess endpoint) | No | Yes |
| `LLAMAPARSE_API_KEY` | [LlamaCloud](https://cloud.llamaindex.ai/) | No | Free tier |
| `ZOTERO_API_KEY` | [Zotero Settings -> Keys](https://www.zotero.org/settings/keys) | No | Free |

Crossref and PubMed require no API keys. Sci-Hub and Unpaywall require no keys either.

**No API keys are strictly required** - GRaDOS will use whichever services are configured and skip the rest. At minimum, Crossref + PubMed + Sci-Hub work with zero configuration.

### Search Priority 🔎

The `search.order` array controls which databases are queried first. GRaDOS searches in order and stops as soon as it has enough unique results:

```json
{
  "search": {
    "order": ["Elsevier", "Springer", "WebOfScience", "Crossref", "PubMed"]
  }
}
```

### Extraction Waterfall 🌊

The `extract.fetchStrategy.order` controls the full-text extraction priority:

```json
{
  "extract": {
    "fetchStrategy": {
      "order": ["TDM", "OA", "SciHub", "Headless"]
    }
  }
}
```

### Storage Directories 🗄️

- `extract.downloadDirectory` defaults to `./downloads` and stores raw PDF files for archival use
- `extract.papersDirectory` defaults to `./papers` and stores parsed Markdown for local indexing
- relative paths are resolved from `PROJECT_ROOT` (the config file's directory); the "Tip: Path Resolution" below shows the full rule set and examples
- `mcp-local-rag`'s `BASE_DIR` must point to the same absolute directory as `extract.papersDirectory`

#### Tip: Path Resolution 💡

GRaDOS resolves paths in two separate scopes:

| Scope | Resolved from | Examples |
|---|---|---|
| **Package assets** | npm install directory (`PACKAGE_ROOT`) | `marker-worker/` |
| **Project files** | Config file's parent directory (`PROJECT_ROOT`) | `downloads/`, `papers/`, `scihub-mirrors.txt` |

**Config file discovery** (in priority order):

1. `--config <path>` CLI argument
2. `GRADOS_CONFIG_PATH` environment variable
3. `cwd/mcp-config.json` (default fallback)

The directory containing the resolved config file becomes `PROJECT_ROOT`. All relative paths in `mcp-config.json` (like `./papers`, `./downloads`) resolve from there — not from `cwd`.

**Examples:**

```bash
# Explicit config path (recommended for MCP client setup)
grados --config D:/Projects/Papers/mcp-config.json

# Or via environment variable
GRADOS_CONFIG_PATH=D:/Projects/Papers/mcp-config.json grados
```

Claude Code (`.claude/settings.json`) — using `--config` instead of `cwd`:

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "D:/Projects/Papers/mcp-config.json"]
    }
  }
}
```

Codex (`~/.codex/config.toml`) — using env var:

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
env = { GRADOS_CONFIG_PATH = "D:/Projects/Papers/mcp-config.json" }
```

If you want storage in a different directory, use absolute paths in config:

```json
{
  "extract": {
    "downloadDirectory": "E:/academic-cache/downloads",
    "papersDirectory": "E:/academic-cache/papers"
  }
}
```

## Claude Code Plugin 🔌

GRaDOS is available as a Claude Code plugin, providing a skill, slash commands, and an MCP server configuration out of the box.

### Install via Marketplace

```bash
/plugin marketplace add https://github.com/STSNaive/GRaDOS.git
/plugin install grados@grados-marketplace
```

### What's Included

| Component | Description |
|---|---|
| **Skill** (`/grados:grados`) | Full academic research workflow — search, extract, synthesize, cite |
| **Command** (`/grados:setup`) | Interactive setup wizard for config, API keys, and dependencies |
| **Command** (`/grados:status`) | Diagnostic check of server, keys, and storage |
| **MCP Server** | Auto-configured `grados` server via `npx -y grados` |

### Configure API Keys

After installing the plugin, set environment variables for the API keys you want to use. The plugin's `.mcp.json` declares all supported env vars with empty defaults — fill in the ones you need:

- `GRADOS_CONFIG_PATH` — path to your `mcp-config.json` (recommended)
- `ELSEVIER_API_KEY`, `WOS_API_KEY`, `SPRINGER_meta_API_KEY`, `SPRINGER_OA_API_KEY`
- `LLAMAPARSE_API_KEY`, `ZOTERO_API_KEY`, `ZOTERO_LIBRARY_ID`
- `ACADEMIC_ETIQUETTE_EMAIL`

Run `/grados:setup` for a guided walkthrough, or `/grados:status` to check what's configured.

## License 📄

MIT
