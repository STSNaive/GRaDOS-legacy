---
description: Guide the user through configuring GRaDOS MCP server, API keys, and optional dependencies.
---

# GRaDOS Setup Guide

You are helping the user set up GRaDOS. Follow these steps in order, stopping to report any issues.

## 1. Check Node.js Environment

Run `node --version` to confirm Node.js is installed (v18+ required).
Run `npx -y grados --version` to confirm grados is available via npx.

If either fails, tell the user to install Node.js 18+ and ensure `npx` is on PATH.

## 2. Generate Config File

Ask the user where they want their project directory (where papers and config will live). Then:

1. `cd` to that directory
2. Run `npx -y grados --init` to generate `mcp-config.json`
3. Show the user the generated file path

## 3. Configure API Keys

Tell the user which API keys are available and how to set them. Show this table:

| Key | Source | Required | Free |
|---|---|---|---|
| `ELSEVIER_API_KEY` | Elsevier Developer Portal | No | Yes (institutional) |
| `WOS_API_KEY` | Clarivate Developer Portal | No | Yes (starter) |
| `SPRINGER_meta_API_KEY` | Springer Nature API | No | Yes |
| `SPRINGER_OA_API_KEY` | Same as above | No | Yes |
| `LLAMAPARSE_API_KEY` | LlamaCloud | No | Free tier |
| `ZOTERO_API_KEY` | Zotero Settings -> Keys | No | Free |

Remind them: **No keys are strictly required.** Crossref + PubMed + Sci-Hub work with zero configuration.

Guide them to add keys to the `apiKeys` section in `mcp-config.json`.

## 4. Set GRADOS_CONFIG_PATH

The user needs to ensure GRaDOS can find the config file. Recommend using `--config`:

```
Claude Code (.claude/settings.json):
{
  "mcpServers": {
    "grados": {
      "command": "npx",
      "args": ["-y", "grados", "--config", "/path/to/mcp-config.json"]
    }
  }
}
```

Or set the `GRADOS_CONFIG_PATH` environment variable to the absolute path of their `mcp-config.json`.

## 5. Optional: Install Marker (High-Quality PDF Parsing)

Ask if they want better PDF parsing. If yes:

1. Confirm Python 3.12 is available: `python3.12 --version`
2. Navigate to the marker-worker directory inside the grados package
3. Run the install script for their platform
4. Update `mcp-config.json` to enable Marker in `extract.parsing.enabled`

## 6. Verify

Run `npx -y grados --version` one more time to confirm everything works.

Tell the user: "Setup complete! You can now use the GRaDOS skill by asking research questions. Try asking about a scientific topic to test the workflow."
