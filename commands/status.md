---
description: Diagnose GRaDOS MCP server status, API key configuration, and dependency health.
---

# GRaDOS Status Check

You are running a diagnostic check on the user's GRaDOS installation. Run each check and report results clearly.

## 1. GRaDOS Availability

Run `npx -y grados --version` and report the version. If it fails, report that GRaDOS is not available via npx.

## 2. Config File

Check the value of `GRADOS_CONFIG_PATH` environment variable (if set). Then check if `mcp-config.json` exists in the current working directory.

Report which config file GRaDOS would use based on the discovery order:
1. `--config` CLI argument (from MCP server config)
2. `GRADOS_CONFIG_PATH` env var
3. `cwd/mcp-config.json`

## 3. API Keys Configured

Check which of these environment variables or config values are set (non-empty):
- `ELSEVIER_API_KEY`
- `WOS_API_KEY`
- `SPRINGER_meta_API_KEY`
- `SPRINGER_OA_API_KEY`
- `LLAMAPARSE_API_KEY`
- `ZOTERO_API_KEY`
- `ZOTERO_LIBRARY_ID`
- `ACADEMIC_ETIQUETTE_EMAIL`

Report as a checklist: ✓ configured / ✗ not set.

Remind user that Crossref, PubMed, Unpaywall, and Sci-Hub work without any API keys.

## 4. Storage Directories

Check if `papers/` and `downloads/` directories exist (relative to config file location or cwd). Report their status and file counts if they exist.

## 5. Marker Worker

Check if `marker-worker/.venv/` exists (relative to the grados package directory or cwd). Report whether Marker appears to be installed.

## 6. Summary

Present a clear summary table:

```
Component          Status
─────────────────────────────
GRaDOS server      ✓/✗ (version)
Config file        ✓/✗ (path)
API keys           N of 8 configured
papers/ directory  ✓/✗ (N files)
downloads/ dir     ✓/✗ (N files)
Marker worker      ✓/✗
```

If any critical issues are found, suggest running `/grados:setup` to fix them.
