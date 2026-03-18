# GRaDOS

[English](./README.md) | [简体中文](./README.zh-CN.md)

<table align="center">
  <tr>
    <td align="center">
<pre style="display:inline-block; margin:0; font-family:'Bitstream Vera Sans Mono', 'SF Mono', Consolas, monospace; font-size:15px; line-height:1; font-weight:bold; white-space:pre; text-align:left;">
&nbsp;&nbsp;.oooooo.&nbsp;&nbsp;&nbsp;&nbsp;ooooooooo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;oooooooooo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.oooooo.&nbsp;&nbsp;&nbsp;&nbsp;.oooooo..o
&nbsp;d8P'&nbsp;&nbsp;`Y8b&nbsp;&nbsp;&nbsp;`888&nbsp;&nbsp;&nbsp;`Y88.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`888'&nbsp;&nbsp;&nbsp;`Y8b&nbsp;&nbsp;&nbsp;d8P'&nbsp;&nbsp;`Y8b&nbsp;&nbsp;d8P'&nbsp;&nbsp;&nbsp;&nbsp;`Y8
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;.d88'&nbsp;&nbsp;.oooo.&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;Y88bo.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888ooo88P'&nbsp;&nbsp;`P&nbsp;&nbsp;)88b&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;`"Y8888o.&nbsp;
888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;ooooo&nbsp;&nbsp;888`88b.&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.oP"888&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;`"Y88b
`88.&nbsp;&nbsp;&nbsp;&nbsp;.88'&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;`88b.&nbsp;&nbsp;d8(&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;888&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;d88'&nbsp;`88b&nbsp;&nbsp;&nbsp;&nbsp;d88'&nbsp;oo&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;.d8P
&nbsp;`Y8bood8P'&nbsp;&nbsp;&nbsp;o888o&nbsp;&nbsp;o888o&nbsp;`Y888""8o&nbsp;o888bood8P'&nbsp;&nbsp;&nbsp;&nbsp;`Y8bood8P'&nbsp;&nbsp;8""88888P'&nbsp;
</pre>
    </td>
  </tr>
</table>

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

**MCP Tools exposed:**

| Server | Tool | Description |
|---|---|---|
| GRaDOS | `search_academic_papers` | Waterfall search across Scopus, Web of Science, Springer, Crossref, and PubMed. Deduplicates by DOI. |
| GRaDOS | `extract_paper_full_text` | 4-stage fetch + 3-stage parse + QA validation. Returns Markdown and auto-saves `.md` to the papers directory. |
| GRaDOS | `save_paper_to_zotero` | Saves cited paper metadata to Zotero web library via API. Called after synthesis for papers used in the answer. |
| mcp-local-rag | `query_documents` | Semantic + keyword search over locally indexed papers. |
| mcp-local-rag | `ingest_file` | Index a paper's Markdown file into the local RAG database. |
| mcp-local-rag | `list_files` | List all indexed papers with status. |

## Installation 🚀

### Option A: npm (recommended) 📦

```bash
npm install -g grados

# Generate config file in your working directory
grados --init

# Edit the config with your API keys
# (see mcp-config.example.json for all options)
```

### Option B: From source 🛠️

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

If you want GRaDOS to load a specific `mcp-config.json`, the manual `cwd` configuration below is the most reliable setup.

Or configure manually - Claude Code (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados"],
      "cwd": "/path/to/directory/containing/mcp-config.json"
    }
  }
}
```

Codex (`~/.codex/config.toml`):

```toml
[mcp_servers.grados]
command = "npx"
args = ["-y", "grados"]
cwd = "/path/to/directory/containing/mcp-config.json"
```

#### Tip: What `cwd` means 💡

`cwd` is the runtime working directory where GRaDOS starts. In the current implementation it is used for:

- loading `mcp-config.json`
- resolving relative output paths such as `./downloads` and `./papers`
- resolving other relative assets such as `./scihub-mirrors.txt`
- locating `./marker-worker` when Marker parsing is enabled

So `cwd` is not "where npm installed the package" - it is "the directory GRaDOS should treat as its runtime project root".

If you want papers to be saved in a different directory, keep `cwd` pointed at the config/runtime directory and use absolute paths in `mcp-config.json`:

```json
{
  "extract": {
    "downloadDirectory": "E:/academic-cache/downloads",
    "papersDirectory": "E:/academic-cache/papers"
  }
}
```

If you use relative paths instead, they are resolved from `cwd`.

### Optional: Install Marker (high-quality local PDF parsing) 🧠

Marker uses deep learning models to convert PDFs to Markdown with much better accuracy than the built-in parser (`pdf-parse`). It is the recommended parser for production use.

> **Current path behavior:** Marker is resolved from `./marker-worker` relative to `cwd`. If you want to enable Marker, use a `cwd` that contains `marker-worker/` (for example the project root), or copy that directory into your runtime/config directory.

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

### Integrated Paper Knowledge Base 🗂️

GRaDOS pairs well with `mcp-local-rag`: GRaDOS fetches and parses papers, while `mcp-local-rag` indexes the saved Markdown for semantic and keyword retrieval.

**Storage separation:** PDFs and Markdown are stored in separate directories to prevent duplicate indexing:

| Directory | Content | Purpose | Configured by |
|---|---|---|---|
| `downloads/` | Raw `.pdf` files | Archival only, not indexed | `extract.downloadDirectory` |
| `papers/` | Parsed `.md` files (with YAML front-matter) | Indexed by `mcp-local-rag` | `extract.papersDirectory` |

Each Markdown file includes structured front-matter:

```yaml
---
doi: "10.1038/s41598-025-29656-1"
title: "Triple-negative complementary metamaterial..."
source: "Unpaywall OA"
fetched_at: "2026-03-17T12:00:00.000Z"
---
```

**Database workflow:**

1. **Extract** - GRaDOS downloads a PDF and parses it, saves `.pdf` to `downloads/` and `.md` to `papers/`
2. **Ingest** - The AI agent calls `ingest_file` on the new `.md` file, which embeds it into a local LanceDB vector store
3. **Query** - On future questions, the workflow can check the local library first via `query_documents`, avoiding redundant API calls and re-extraction
4. **Manage** - Use `list_files` to see all indexed papers and `delete_file` to remove outdated entries

> **Note:** `mcp-local-rag` does not auto-scan directories. Papers must be explicitly ingested via the `ingest_file` tool. The included `SKILL.md` workflow can handle this automatically.

### Optional: Install mcp-local-rag (local paper library with RAG) 🔎

[mcp-local-rag](https://github.com/shinpr/mcp-local-rag) provides a local paper library with semantic search. GRaDOS automatically saves parsed Markdown files to a `papers/` directory that `mcp-local-rag` can index and make searchable. No Python is required - it is pure Node.js, just like GRaDOS.

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

> **Important:** `BASE_DIR` must point to the same absolute directory as `extract.papersDirectory` in `mcp-config.json`. If `extract.papersDirectory` is relative, resolve it from `cwd` first.

The storage split and ingest/query flow are described above in **Integrated Paper Knowledge Base**. The additional thing to remember here is that `mcp-local-rag` does **not** auto-scan directories - the agent still needs to call `ingest_file` for each new Markdown file.

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
- relative paths are resolved from `cwd`; if you want storage elsewhere, use absolute paths
- `mcp-local-rag`'s `BASE_DIR` must point to the same absolute directory as `extract.papersDirectory`

## SKILL.md 🤖

The `skills/GRaDOS/SKILL.md` file is a structured prompt that teaches the AI agent the research workflow around GRaDOS and `mcp-local-rag`. Copy it into your agent's skill/prompt directory to enable the full workflow.

## License 📄

MIT
