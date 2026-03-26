---
description: Guide the user through configuring GRaDOS after plugin installation.
---

# GRaDOS Setup

You are helping the user configure GRaDOS after plugin installation. The plugin has already registered all MCP servers (grados, local-rag, playwright). The user only needs a config file with their API keys.

**SECURITY: NEVER ask the user to paste API keys into this conversation. Guide them to edit the file with their own editor.**

## 1. Check Prerequisites

Run `node --version` to confirm Node.js is installed (v18+ required, v20+ for mcp-local-rag).

## 2. Generate Config File

The plugin stores configuration at `${CLAUDE_PLUGIN_DATA}/grados-config.json`.

Check if the config file already exists:

```bash
test -f "${CLAUDE_PLUGIN_DATA}/grados-config.json" && echo "Config exists" || echo "Config not found"
```

If it does NOT exist, create it by running:

```bash
cd "${CLAUDE_PLUGIN_DATA}" && npx -y grados --init
```

This generates `grados-config.json` with default settings. The `papers/` and `downloads/` directories will be created automatically under `${CLAUDE_PLUGIN_DATA}/` when papers are extracted.

## 3. Guide User to Configure API Keys

Tell the user:

> The config file has been created at:
> `${CLAUDE_PLUGIN_DATA}/grados-config.json`
>
> Please open this file in your editor and fill in the API keys you have.
> **No keys are strictly required** — Crossref, PubMed, Unpaywall, and Sci-Hub work with zero configuration.

Show this table of available keys:

| Key | Source | Required | Free |
|---|---|---|---|
| `academicEtiquetteEmail` | Your institutional email | Recommended | - |
| `ELSEVIER_API_KEY` | Elsevier Developer Portal | No | Yes (institutional) |
| `WOS_API_KEY` | Clarivate Developer Portal | No | Yes (starter) |
| `SPRINGER_meta_API_KEY` | Springer Nature API Portal | No | Yes |
| `SPRINGER_OA_API_KEY` | Same as above | No | Yes |
| `LLAMAPARSE_API_KEY` | LlamaCloud | No | Free tier |
| `ZOTERO_API_KEY` | Zotero Settings -> Keys | No | Free |

All keys go in the `apiKeys` section of the config file. The `academicEtiquetteEmail` is a top-level field.

## 4. Reload Plugin

After the user confirms they have saved the config file, tell them to run:

```
/reload-plugins
```

This restarts all MCP servers so grados picks up the new config.

## 5. Verify

Run a quick test by asking: "Try asking me a research question to test the setup, or run `/grados:status` to check the configuration."
