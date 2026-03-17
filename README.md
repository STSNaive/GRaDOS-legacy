# GRaDOS

**Graduate Research and Document Operating System**

GRaDOS is an MCP server that gives AI agents (Claude, Codex, etc.) the ability to search academic databases, download full-text papers through paywalls, and synthesize citation-grounded answers. It is designed for campus network environments where institutional access provides database permissions.

## Architecture

```
User Question
  |
  v
SKILL.md (6-step academic protocol)
  |
  ├─ Step 0: Check Local Paper Library (mcp-local-rag)
  │    └─ Semantic + keyword search over previously downloaded papers
  ├─ Step 1: Query Decomposition
  ├─ Step 2: Relevance Screening (abstract / title filtering)
  ├─ Step 3: Full-Text Extraction & Indexing
  │    ├─ Waterfall Fetch: TDM API → Unpaywall OA → Sci-Hub → Headless Browser
  │    ├─ Progressive Parse: LlamaParse → Marker (local GPU) → pdf-parse
  │    ├─ QA Validation: length + paywall detection + structure + title match
  │    ├─ PDF saved to downloads/  (archival)
  │    └─ Markdown saved to papers/ (RAG-indexed by mcp-local-rag)
  ├─ Step 4: Synthesis & Citation (Chinese output)
  └─ Step 5: Double-Check Protocol (anti-hallucination)
```

**MCP Tools exposed:**

| Server | Tool | Description |
|---|---|---|
| GRaDOS | `search_academic_papers` | Waterfall search across Scopus, Web of Science, Springer, Crossref, PubMed. Deduplicates by DOI. |
| GRaDOS | `extract_paper_full_text` | 4-stage fetch + 3-stage parse + QA validation. Returns Markdown. Auto-saves `.md` to papers directory. |
| GRaDOS | `save_paper_to_zotero` | Saves cited paper metadata to Zotero web library via API. Called after synthesis for papers used in the answer. |
| mcp-local-rag | `query_documents` | Semantic + keyword search over locally indexed papers. |
| mcp-local-rag | `ingest_file` | Index a paper's Markdown file into the local RAG database. |
| mcp-local-rag | `list_files` | List all indexed papers with status. |

## Installation

### Option A: npm (recommended)

```bash
npm install -g grados

# Generate config file in your working directory
grados --init

# Edit the config with your API keys
# (see mcp-config.example.json for all options)
```

### Option B: From source

```bash
git clone https://github.com/STSNaive/GRaDOS.git
cd GRaDOS
npm install
npm run build

cp mcp-config.example.json mcp-config.json
# Edit mcp-config.json with your API keys
```

### Configure your MCP client

**Claude Code:**

```bash
claude mcp add --transport stdio grados -- npx -y grados
```

**Codex:**

```bash
codex mcp add grados -- npx -y grados
```

Or configure manually — Claude Code (`.claude/settings.json`):

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

### Optional: Install Marker (high-quality local PDF parsing)

Marker uses deep learning models to convert PDFs to Markdown with much better accuracy than the built-in parser. Requires Python 3.12.

```powershell
cd marker-worker
.\install.ps1              # Auto-detect CPU/GPU
.\install.ps1 -Torch cuda  # Force GPU (CUDA)
.\install.ps1 -Torch cpu   # Force CPU
```

### Optional: Install mcp-local-rag (local paper library with RAG)

[mcp-local-rag](https://github.com/shinpr/mcp-local-rag) provides a local paper library with semantic search. GRaDOS automatically saves parsed Markdown files to a `papers/` directory that mcp-local-rag indexes and makes searchable. No Python required — it's pure Node.js, just like GRaDOS.

**Register with your MCP client (one command):**

```bash
# Claude Code
claude mcp add local-rag -- npx -y mcp-local-rag

# Codex
codex mcp add local-rag -- npx -y mcp-local-rag
```

Or configure manually (`.claude/settings.json`):

```json
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados"],
      "cwd": "/path/to/project"
    },
    "local-rag": {
      "command": "npx",
      "args": ["-y", "mcp-local-rag"],
      "env": {
        "BASE_DIR": "/path/to/project/papers"
      }
    }
  }
}
```

> **Important:** `BASE_DIR` must point to the same directory as `extract.papersDirectory` in `mcp-config.json` (default: `./papers`).

**How it works:**

```
GRaDOS extracts paper              mcp-local-rag indexes papers/
         │                                   │
         ▼                                   ▼
  downloads/                           LanceDB vector store
  └── 10_1234_xxxxx.pdf (archival)     ┌───────────────────┐
                                       │ query_documents    │ ◄── AI Agent
  papers/                              │ ingest_file        │
  ├── 10_1234_xxxxx.md  ─────────────► │ list_files         │
  └── 10_5678_yyyyy.md  ─────────────► │ delete_file        │
                                       └───────────────────┘
```

- GRaDOS saves raw **PDFs** to `downloads/` (archival, not indexed).
- GRaDOS saves parsed **Markdown** (with YAML front-matter: DOI, title, source) to `papers/`.
- The AI agent calls `ingest_file` on each new `.md` file to index it into mcp-local-rag's vector database.
- Next time, the SKILL.md protocol checks the local library first via `query_documents`, saving API calls and extraction time.

### Optional: Zotero web library integration

GRaDOS can automatically save cited papers to your [Zotero](https://www.zotero.org/) web library after each research session. No desktop client required — it uses the Zotero Web API directly.

**Setup:**

1. Get your **API key** at `https://www.zotero.org/settings/keys` → New Key → check "Write Access".
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

## Configuration

All configuration lives in a single file: `mcp-config.json`. Run `grados --init` to generate one from the template.

### API Keys

| Key | Source | Required | Free |
|---|---|---|---|
| `ELSEVIER_API_KEY` | [Elsevier Developer Portal](https://dev.elsevier.com/) | No | Yes (institutional) |
| `WOS_API_KEY` | [Clarivate Developer Portal](https://developer.clarivate.com/) | No | Yes (starter) |
| `SPRINGER_meta_API_KEY` | [Springer Nature API](https://dev.springernature.com/) | No | Yes |
| `SPRINGER_OA_API_KEY` | Same as above (OpenAccess endpoint) | No | Yes |
| `LLAMAPARSE_API_KEY` | [LlamaCloud](https://cloud.llamaindex.ai/) | No | Free tier |
| `ZOTERO_API_KEY` | [Zotero Settings → Keys](https://www.zotero.org/settings/keys) | No | Free |

Crossref and PubMed require no API keys. Sci-Hub and Unpaywall require no keys either.

**No API keys are strictly required** -- GRaDOS will use whichever services are configured and skip the rest. At minimum, Crossref + PubMed + Sci-Hub work with zero configuration.

### Search Priority

The `search.order` array controls which databases are queried first. GRaDOS searches in order and stops as soon as it has enough unique results:

```json
{
  "search": {
    "order": ["Elsevier", "Springer", "WebOfScience", "Crossref", "PubMed"]
  }
}
```

### Extraction Waterfall

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

### Storage Directories

| Setting | Default | Description |
|---|---|---|
| `extract.downloadDirectory` | `./downloads` | Raw PDF files (archival, not indexed by RAG) |
| `extract.papersDirectory` | `./papers` | Parsed Markdown files (indexed by mcp-local-rag) |

mcp-local-rag's `BASE_DIR` environment variable must point to the same path as `extract.papersDirectory`.

## SKILL.md

The `skills/GRaDOS/SKILL.md` file is a structured prompt that teaches the AI agent the 6-step research protocol (Step 0: local library check + Steps 1-5). Copy it into your agent's skill/prompt directory to enable the full workflow.

## License

MIT
