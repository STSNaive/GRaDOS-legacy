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

1. Check the local paper library first via `search_saved_papers`; when a compatible `mcp-local-rag` index exists, GRaDOS reuses semantic retrieval, otherwise it falls back to compact Markdown search
2. Search remote academic sources in configured priority order
3. Fetch full text with a waterfall: `TDM -> OA -> Sci-Hub -> Headless`
4. Parse PDFs with `LlamaParse -> Marker -> Native`
5. Run QA checks before returning content
6. Save raw PDFs to `downloads/` and parsed Markdown to `markdown/` for later reuse

### MCP Tools 🔧

| Server | Tool | Description |
|---|---|---|
| GRaDOS | `search_academic_papers` | Waterfall search across Scopus, Web of Science, Springer, Crossref, and PubMed. Deduplicates by DOI and can continue later with `continuation_token` to fetch more unseen papers. |
| GRaDOS | `search_saved_papers` | Compact paper-level search over the saved-paper store in `markdown/` by default. If a compatible `mcp-local-rag` CLI + index is available, GRaDOS uses semantic+keyword retrieval; otherwise it automatically falls back to lexical search over saved Markdown. Returns `doi`, `safe_doi`, `canonical_uri`, snippets, and matched sections instead of raw chunks. |
| GRaDOS | `extract_paper_full_text` | 4-stage fetch + 3-stage parse + QA validation. Auto-saves full-text `.md` to the papers directory and returns a **compact, non-citable saved-paper summary** (title, DOI, canonical path/URI, short preview, section headings) to keep the agent's context window clean. |
| GRaDOS | `parse_pdf_file` | Parse a local PDF via configured waterfall (LlamaParse → Marker → Native). Use after downloading PDFs with Playwright MCP. If a DOI is provided, it returns the same saved-paper summary contract as `extract_paper_full_text`. |
| GRaDOS | `read_saved_paper` | Canonical deep-reading tool for saved papers. Accepts `doi`, `safe_doi`, or `grados://papers/{safe_doi}` and returns a paragraph window for synthesis and citation verification. |
| GRaDOS | `save_paper_to_zotero` | Saves cited paper metadata to Zotero web library via API. Called after synthesis for papers used in the answer. |
| mcp-local-rag | `query_documents` | Semantic + keyword search over locally indexed papers. |
| mcp-local-rag | `ingest_file` | Index a paper's Markdown file into the local RAG database. |
| mcp-local-rag | `list_files` | List all indexed papers with status. |
| mcp-local-rag | `delete_file` | Remove stale indexed entries from the local RAG database. |
| mcp-local-rag | `status` | Inspect local RAG database health and configuration warnings. |

### SKILL.md (Companion Skill) 🤖

`skills/grados/SKILL.md` is the companion structured prompt that describes the research workflow around GRaDOS and optional `mcp-local-rag` acceleration. Copy it into your agent's skill/prompt directory to enable the full workflow.

### Local Paper Knowledge Base 🗂️

After extracting a paper, GRaDOS stores the PDF and the parsed Markdown separately to prevent duplicate indexing:

| Directory | Content | Purpose | Configured by |
|---|---|---|---|
| `downloads/` | Raw `.pdf` files | Archival only, not indexed | `extract.downloadDirectory` |
| `markdown/` | Parsed `.md` files (with YAML front-matter) | Available for semantic and keyword retrieval | `extract.papersDirectory` |

Each Markdown file includes structured front-matter:

```yaml
---
doi: "10.1038/s41598-025-29656-1"
title: "Triple-negative complementary metamaterial..."
source: "Unpaywall OA"
fetched_at: "2026-03-17T12:00:00.000Z"
---
```

Pair with [`mcp-local-rag`](https://github.com/shinpr/mcp-local-rag) to build a vector index over `markdown/` for local semantic and keyword retrieval. GRaDOS's `search_saved_papers` tool will reuse that index when available, and automatically fall back to compact lexical search when it is not. The full workflow:

1. **Extract** - GRaDOS downloads a PDF and parses it, saves `.pdf` to `downloads/` and `.md` to `markdown/`
2. **Ingest** - The AI agent calls `ingest_file` on the new `.md` file, which embeds it into a local LanceDB vector store
3. **Query** - On future questions, the workflow can check the local library first via `search_saved_papers`; if raw chunk access is needed, `query_documents` remains available
4. **Manage** - Use `list_files` to see all indexed papers and `delete_file` to remove outdated entries

> **Note:** `mcp-local-rag` does not auto-scan directories. Papers must still be explicitly ingested via `ingest_file` to enter the semantic index. Even without that index, `search_saved_papers` can still search saved Markdown lexically.

GRaDOS also exposes the saved paper store as installation-agnostic MCP surfaces:

- `read_saved_paper` is the canonical tool for model-driven deep reading.
- `grados://papers/index` lists saved papers.
- `grados://papers/{safe_doi}` provides the canonical full Markdown resource for one saved paper.

## Installation 🚀

### Option A: Claude Code Plugin (easiest) 🔌

If you use [Claude Code](https://code.claude.com/) (CLI or Desktop), install GRaDOS as a plugin. This automatically registers all three MCP servers (GRaDOS, mcp-local-rag, Playwright) with no manual configuration.

> The plugin bundles the same GRaDOS stdio MCP server described below. It does not introduce a separate plugin-only paper-reading API.

**1. Add the marketplace and install:**

```bash
# In Claude Code
/plugin marketplace add https://github.com/STSNaive/GRaDOS.git
/plugin install grados@grados-marketplace
```

**2. Run the setup command:**

```
/grados:setup
```

This creates `${CLAUDE_PLUGIN_DATA}/grados-config.json` and guides you through setting API keys. The plugin also preconfigures `local-rag` with `BASE_DIR=${CLAUDE_PLUGIN_DATA}/markdown`, `DB_PATH=${CLAUDE_PLUGIN_DATA}/lancedb`, `CACHE_DIR=${CLAUDE_PLUGIN_DATA}/models`, and `MODEL_NAME=Xenova/all-MiniLM-L6-v2`, so no environment variables or shell profile editing are required for the default setup.

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
# (see grados-config.example.json for all options)
```

To check for updates: `npm outdated -g grados` — if a newer version is available, run `npm install -g grados` again.

### Option C: From source 🛠️

```bash
git clone https://github.com/STSNaive/GRaDOS.git
cd GRaDOS
npm install
npm run build

cp grados-config.example.json grados-config.json
# Edit grados-config.json with your API keys
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

If you want GRaDOS to load a specific `grados-config.json`, use `--config` (recommended) or `GRADOS_CONFIG_PATH`:

Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "/path/to/papers/grados-config.json"]
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados", "--config", "/path/to/papers/grados-config.json"]
```

The same GRaDOS API surface is available whether the server is started via `npx`, source checkout, or bundled inside the Claude plugin. Installation method only changes how the stdio server is launched and where its config file lives.

### Optional: Install Marker (high-quality local PDF parsing) 🧠

Marker uses deep learning models to convert PDFs to Markdown with much better accuracy than the built-in parser (`pdf-parse`). It is the recommended parser for production use.

> **Path behavior:** If `extract.parsing.markerWorkerDirectory` is configured, GRaDOS uses it directly; otherwise it falls back to `PROJECT_ROOT/marker-worker` (if present) and then `PACKAGE_ROOT/marker-worker`. `markerWorkerDirectory` must point to the **`marker-worker` directory itself**, meaning the folder containing `worker.py`, `install.sh` / `install.ps1`, and `local.env`, not its parent directory.

**Prerequisites:** Python 3.12 (required by `marker-pdf`). Optional: NVIDIA GPU + CUDA on Windows/Linux for acceleration.

If you launch GRaDOS via `npx`, it is best to scaffold a stable project-local `marker-worker/` directory first and then point the config at it:

```bash
npx -y grados --config /path/to/papers/grados-config.json --init-marker
```

This creates `marker-worker/` next to `grados-config.json`. If your config lives at `/path/to/papers/grados-config.json`, the recommended final directory is:

```text
/path/to/papers/marker-worker
```

**Install (macOS/Linux):**

```bash
cd marker-worker
chmod +x ./install.sh
./install.sh               # Unified uv install; on Linux with NVIDIA, asks [y/N] about CUDA
./install.sh --device cpu  # Force CPU
./install.sh --device cuda # Linux only
```

**Install (Windows PowerShell):**

```powershell
cd marker-worker
.\install.ps1              # Unified uv install; if NVIDIA is detected, asks [y/N] about CUDA
.\install.ps1 -Device cpu  # Force CPU
.\install.ps1 -Device cuda # Force CUDA
```

The install scripts will:
1. Create or sync a Python 3.12 virtual environment via `uv`
2. Write `marker-worker/local.env` with `MARKER_PYTHON` and optional `TORCH_DEVICE`
3. Prewarm Marker models into `marker-worker/.cache/` (unless `--skip-prewarm` is used)
4. Run `verify.py` so installation only succeeds after GRaDOS can launch the local Marker worker

By default, Marker auto-detects the best torch device. On macOS, this allows PyTorch to use MPS when available. CUDA remains an explicit opt-in path; if a CUDA attempt fails verification, the installer falls back to CPU compatibility so GRaDOS can still use Marker.

> **local.env behavior:** GRaDOS first resolves the `marker-worker/` directory via `extract.parsing.markerWorkerDirectory` (or the default search order), then reads `MARKER_PYTHON` from that directory's `local.env` before falling back to standard `.venv/` interpreter locations.

**Enable in config:** After installation, update `grados-config.json` to enable Marker:

```json
{
  "extract": {
    "parsing": {
      "markerWorkerDirectory": "./marker-worker",
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

[mcp-local-rag](https://github.com/shinpr/mcp-local-rag) provides semantic and keyword retrieval for local papers. Pure Node.js, no Python required. GRaDOS's built-in `search_saved_papers` tool can reuse the same CLI + DB for semantic retrieval when available, and otherwise falls back to lexical saved-paper search.

> **Version note:** the current `mcp-local-rag` 0.10.x line requires Node.js 20 or newer.
>
> **Check for updates:** `npm outdated -g mcp-local-rag` — if a newer version is available, run `npm install -g mcp-local-rag` again.

**Register with your MCP client:**

```bash
# Claude Code
claude mcp add local-rag -- npx -y mcp-local-rag

# Codex (fully align the standalone server with GRaDOS localRag defaults)
codex mcp add local-rag \
  --env BASE_DIR=/path/to/papers/markdown \
  --env DB_PATH=/path/to/papers/lancedb \
  --env CACHE_DIR=/path/to/papers/models \
  --env MODEL_NAME=Xenova/all-MiniLM-L6-v2 \
  -- npx -y mcp-local-rag
```

For Claude Code, the manual config below is the clearest way to ensure `BASE_DIR`, `DB_PATH`, `CACHE_DIR`, and `MODEL_NAME` stay aligned with `grados-config.json`.

Or configure manually - Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados"],
      "cwd": "/path/to/papers"
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/papers/markdown",
        "DB_PATH": "/path/to/papers/lancedb",
        "CACHE_DIR": "/path/to/papers/models",
        "MODEL_NAME": "Xenova/all-MiniLM-L6-v2"
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
cwd = "/path/to/papers"

[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]
env = { BASE_DIR = "/path/to/papers/markdown", DB_PATH = "/path/to/papers/lancedb", CACHE_DIR = "/path/to/papers/models", MODEL_NAME = "Xenova/all-MiniLM-L6-v2" }
```

> **Important:** `BASE_DIR` must point to the same absolute directory as `extract.papersDirectory` in `grados-config.json`. If `extract.papersDirectory` is relative, resolve it from `PROJECT_ROOT` first (usually the config file's directory). To keep direct `local-rag:*` calls and `grados:search_saved_papers` on the same semantic index, align `DB_PATH`, `CACHE_DIR`, and `MODEL_NAME` with `localRag.dbPath`, `localRag.cacheDir`, and `localRag.modelName`.


### Optional: Zotero web library integration 📚

GRaDOS can automatically save cited papers to your [Zotero](https://www.zotero.org/) web library after each research session. No desktop client is required - it uses the Zotero Web API directly.

**Setup:**

1. Get your **API key** at `https://www.zotero.org/settings/keys` -> New Key -> check "Write Access".
2. Get your **library ID** (numeric user ID shown on the same page as "Your userID for use in API calls").
3. Add both to `grados-config.json`:

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

When GRaDOS's built-in headless browser (Patchright) fails to extract a PDF — typically due to complex publisher page layouts or CAPTCHA challenges — the AI agent can fall back to [Playwright MCP](https://github.com/microsoft/playwright-mcp), which gives the LLM direct browser control through accessibility tree snapshots.

**Why Playwright MCP over the built-in browser?** The built-in browser uses hardcoded CSS selectors that break on unfamiliar publisher pages. With Playwright MCP, the LLM sees the page structure and can adaptively click the right download button, regardless of layout. This is token-expensive (~13.7K base + page content), so it's only used as a fallback when the zero-cost built-in path fails.

The built-in headless browser uses **Patchright** (a Playwright fork with CDP-level anti-detection patches) and supports **Windows, macOS, and Linux**. It requires a Chromium-based browser (`msedge` or `chrome`). GRaDOS probes paths for the configured browser on the current OS, and you can override the executable directly with `headlessBrowser.executablePath` in `grados-config.json`.

**Install:**

```bash
npm install -g @playwright/mcp
```

To check for updates: `npm outdated -g @playwright/mcp` — if a newer version is available, run `npm install -g @playwright/mcp` again.

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

> **Note:** Playwright MCP is entirely optional. Without it, GRaDOS still works through its built-in waterfall (TDM → OA → Sci-Hub → Headless Patchright). Playwright MCP adds an LLM-driven safety net for the cases the built-in browser can't handle.

### Configuration Example: GRaDOS + mcp-local-rag + Playwright 🧩

If you want to wire up the most common end-to-end research workflow in one shot, configure these three MCP services together. This example assumes your config file lives at `/path/to/papers/grados-config.json`, that `extract.papersDirectory` uses the default relative path `./markdown`, and that `localRag.dbPath` / `localRag.cacheDir` keep their default relative values `./lancedb` / `./models`. With those defaults, `mcp-local-rag` should point to the paths below.

Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "/path/to/papers/grados-config.json"]
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/papers/markdown",
        "DB_PATH": "/path/to/papers/lancedb",
        "CACHE_DIR": "/path/to/papers/models",
        "MODEL_NAME": "Xenova/all-MiniLM-L6-v2"
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
args = ["-y", "grados", "--config", "/path/to/papers/grados-config.json"]

[mcp_servers.local-rag]
command = "npx"
args = ["-y", "mcp-local-rag"]
env = { BASE_DIR = "/path/to/papers/markdown", DB_PATH = "/path/to/papers/lancedb", CACHE_DIR = "/path/to/papers/models", MODEL_NAME = "Xenova/all-MiniLM-L6-v2" }

[mcp_servers.playwright]
command = "npx"
args = ["@playwright/mcp", "--headless"]
```

## Configuration ⚙️

All configuration lives in a single file: `grados-config.json`. Run `grados --init` to generate one from the template.

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

To continue the same search later without repeating the same top results, call `search_academic_papers` again with the same `query` plus the `next_continuation_token` returned in `structuredContent`. Each follow-up call returns the next batch of unseen papers until `has_more` becomes `false`.

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
- `extract.papersDirectory` defaults to `./markdown` and stores parsed Markdown for local indexing
- relative paths are resolved from `PROJECT_ROOT` (the config file's directory); the "Tip: Path Resolution" below shows the full rule set and examples
- `mcp-local-rag`'s `BASE_DIR` must point to the same absolute directory as `extract.papersDirectory`; align `DB_PATH`, `CACHE_DIR`, and `MODEL_NAME` with `localRag.dbPath`, `localRag.cacheDir`, and `localRag.modelName` when you want shared semantic search

#### Tip: Path Resolution 💡

GRaDOS resolves paths in two separate scopes:

| Scope | Resolved from | Examples |
|---|---|---|
| **Package assets** | npm install directory (`PACKAGE_ROOT`) | default fallback `marker-worker/` |
| **Project files** | Config file's parent directory (`PROJECT_ROOT`) | `downloads/`, `markdown/`, `scihub-mirrors.txt`, optional `marker-worker/` |

**Config file discovery** (in priority order):

1. `--config <path>` CLI argument
2. `GRADOS_CONFIG_PATH` environment variable
3. `cwd/grados-config.json` (default fallback)

The directory containing the resolved config file becomes `PROJECT_ROOT`. All relative paths in `grados-config.json` (like `./markdown`, `./downloads`) resolve from there — not from `cwd`.

**Examples:**

```bash
# Explicit config path (recommended for MCP client setup)
grados --config /path/to/papers/grados-config.json

# Or via environment variable
GRADOS_CONFIG_PATH=/path/to/papers/grados-config.json grados
```

Claude Code (`.claude/settings.json`) — using `--config` instead of `cwd`:

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "/path/to/papers/grados-config.json"]
    }
  }
}
```

Codex (`~/.codex/config.toml`) — using env var:

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
env = { GRADOS_CONFIG_PATH = "/path/to/papers/grados-config.json" }
```

If you want storage in a different directory, use absolute paths in config:

```json
{
  "extract": {
    "downloadDirectory": "/path/to/custom-storage/downloads",
    "papersDirectory": "/path/to/custom-storage/markdown"
  }
}
```

## Claude Code Plugin 🔌

GRaDOS is available as a Claude Code plugin, providing a skill, slash commands, and an MCP server configuration out of the box. Use Installation > Option A above to install it from this repository's marketplace manifest.

### What's Included

| Component | Description |
|---|---|
| **Skill** (`/grados:grados`) | Full academic research workflow — search, extract, synthesize, cite |
| **Command** (`/grados:setup`) | Interactive setup wizard for config, API keys, and dependencies |
| **Command** (`/grados:status`) | Diagnostic check of server, keys, and storage |
| **MCP Server** | Auto-configured `grados` server via `npx -y grados` |

### How Configuration Works

The bundled `.mcp.json` wires the plugin up like this:

- `grados` is launched with `--config ${CLAUDE_PLUGIN_DATA}/grados-config.json`
- `local-rag` is launched with `BASE_DIR=${CLAUDE_PLUGIN_DATA}/markdown`, `DB_PATH=${CLAUDE_PLUGIN_DATA}/lancedb`, `CACHE_DIR=${CLAUDE_PLUGIN_DATA}/models`, and `MODEL_NAME=Xenova/all-MiniLM-L6-v2`
- `playwright` is launched in headless mode

Run `/grados:setup` to create `${CLAUDE_PLUGIN_DATA}/grados-config.json`, edit that file with the API keys you want to use, then run `/reload-plugins` so the bundled MCP servers pick up the updated config. No shell environment variables are required for the default plugin workflow.

Run `/grados:status` to verify the final setup.

## License 📄

MIT
