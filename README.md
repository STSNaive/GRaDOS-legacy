# GraDOS (`phd-pro`)
**Genetic Research & Document Operating System**

GraDOS is an advanced, multi-stage Model Context Protocol (MCP) server built for AI Academic Research Agents (like Codex). It bridges the gap between your local AI and the paywalled/open academic publishing world, guaranteeing hallucination-free Literature Reviews.

## 🧬 Architecture
This project consists of two perfectly intertwined parts:

1. **GraDOS MCP Server (Node.js)**
    - *The Brawn*: A highly obfuscated, resilient PDF extraction engine.
    - Exposes two tools to your AI Agent: 
        1. `search_academic_papers`: Concurrently federates searches across Web of Science, Springer, Elsevier, Crossref, and PubMed.
        2. `extract_paper_full_text`: Executes a 4-Stage Waterfall Full-Text Fetch (Official TDM API ➡️ Unpaywall OA ➡️ Sci-Hub Mirror Auto-Routing ➡️ Edge Browser Anti-Captcha Spoofer) followed by a 3-Stage Progressive Degradation Parser (LlamaParse ➡️ Local Marker GPU ➡️ Node Native) to deliver pure Markdown.

2. **The SKILL (`skills/GraDOS/SKILL.md`)**
    - *The Brains*: A strictly dictated AI prompt/workflow instruction set.
    - Forces the LLM to follow a rigorous 4-Step Academic Protocol: Decompose question > Filter Abstracts > Extract Full Text > Synthesize & **Double-Check** every generated claim against the raw Markdown from GraDOS.

## 🛠️ Usage
1. Configure your API keys (Elsevier, WoS, Springer, LlamaParse) and paths in `mcp-config.json`.
2. `npm run build`
3. Link the `dist/index.js` to your Codex or AI Agent as an MCP server.
4. Provide the Agent with the `SKILL.md` ruleset.
5. Ask your most difficult research question!
