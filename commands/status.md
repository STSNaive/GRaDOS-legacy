---
description: Diagnose GRaDOS MCP server status, config, API keys, and dependency health.
---

# GRaDOS Status Check

You are running a diagnostic check on the user's GRaDOS installation. Run each check and report results clearly.

## 1. GRaDOS Availability

Run `npx -y grados --version` and report the version. If it fails, report that GRaDOS is not available via npx.

## 2. Config File

Check for config files in this priority order:

1. **Plugin data directory**: `${CLAUDE_PLUGIN_DATA}/grados-config.json` (used when installed as a Claude Code plugin)
2. **GRADOS_CONFIG_PATH** environment variable (if set)
3. **Current directory**: `./grados-config.json`

For each path, check if the file exists. Report which config file GRaDOS would use.

If no config file is found, suggest running `/grados:setup`.

## 3. API Keys Configured

Read the config file found in Step 2. Check which API keys are set (non-empty) in the `apiKeys` section:
- `ELSEVIER_API_KEY`
- `WOS_API_KEY`
- `SPRINGER_meta_API_KEY`
- `SPRINGER_OA_API_KEY`
- `LLAMAPARSE_API_KEY`
- `ZOTERO_API_KEY`

Also check if `academicEtiquetteEmail` is configured (not empty or default placeholder).

**SECURITY: Do NOT display the actual key values. Only report whether each key is set or not.**

Report as a checklist: configured / not set.

Remind user that Crossref, PubMed, Unpaywall, and Sci-Hub work without any API keys.

## 4. Storage Directories

Check if `papers/` and `downloads/` directories exist relative to the config file location. Report their status and file counts if they exist.

## 5. Companion MCP Servers

Check if these companion tools are available (try calling them or checking MCP server status):
- **mcp-local-rag**: `local-rag:status` — report if available
- **Playwright MCP**: check if playwright browser tools are available

## 6. Summary

Present a clear summary table:

```
Component          Status
─────────────────────────────
GRaDOS server      [version or error]
Config file        [path or "not found"]
API keys           N of 6 configured
Email              [set or "not set"]
papers/ directory  [N files or "not found"]
downloads/ dir     [N files or "not found"]
mcp-local-rag      [available or "not found"]
Playwright MCP     [available or "not found"]
```

If any critical issues are found, suggest running `/grados:setup` to fix them.
