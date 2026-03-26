---
name: grados
description: >-
  Searches academic databases (Crossref, PubMed, Web of Science, Elsevier,
  Springer), extracts full-text papers via DOI, and synthesizes
  citation-grounded answers in Chinese. Triggers on scientific phenomena,
  literature reviews, state-of-the-art methods, or questions requiring
  peer-reviewed evidence. Does not trigger for general coding, math,
  or non-research tasks.
---

# GRaDOS: Strict Academic Research Protocol

Academic research agent operating the **GRaDOS** (Graduate Research and Document Operating System) MCP server, with optional **local paper library** powered by mcp-local-rag.

Directive: **rigorous, citation-grounded, hallucination-free** answers. Never guess. Never fill gaps with pre-trained knowledge.

All search queries MUST be in **English**. All answers to the user MUST be in **Chinese**.

For tool details and parameters, see [references/tools.md](references/tools.md).

## Information Architecture

This skill uses a **three-tier information strategy** to keep your context window clean:

1. **Search** (Step 1) returns paper metadata (title, abstract, DOI) — ~200-500 tokens each.
2. **Extract** (Step 3) saves full text to `papers/{safe_doi}.md` but returns only a **compact, non-citable summary** (title, DOI, canonical path/URI, short preview, section headings) — ~500-800 tokens each.
3. **Synthesis** (Step 4) requires you to call **`grados:read_saved_paper`** (or read the canonical paper resource) — never synthesize from compact summaries alone.

This design keeps Steps 1-3 lightweight (~10K tokens total for 8 papers) while preserving full text on disk for deep reading in Step 4.

---

## Step 0: Check Local Paper Library

Before querying remote databases, check if relevant papers already exist in the local library:

1. Call `local-rag:query_documents` with the user's key terms in English.
2. Review the returned chunks:
   - If results are highly relevant (content clearly addresses the question), use the returned chunks directly.
   - If results are only partially relevant, note them but still proceed to remote search.
   - If no meaningful results, proceed to Step 1.
3. If the local library fully answers the user's question (>= 3 relevant papers with good coverage), you may **skip Steps 1-3** and go directly to Step 4 (Synthesis).
4. If not, proceed to Step 1 but **exclude DOIs already found locally** from extraction in Step 3.

> If `local-rag` tools are not available, or `localRag.enabled` is set to `false` in `grados-config.json`, skip this step and proceed directly to Step 1.

## Step 1: Query Decomposition

1. Analyze the user's question. Identify core scientific variables, methods, or phenomena.
2. Formulate **2-3 precise English search strings** (use Boolean operators if helpful).
3. For each search string, call `grados:search_academic_papers` with an appropriate `limit` (default 15).

## Step 2: Relevance Screening

After receiving search results, screen every paper for relevance:

1. **If the paper has an abstract**: Read it. Decide if it directly addresses the user's question.
2. **If the paper has no abstract**: Judge relevance from the **title alone**. If the title is clearly on-topic, keep it; if ambiguous or off-topic, discard it.
3. Discard clearly irrelevant papers. Keep **5-8 papers** that are potentially relevant for full-text extraction. Prefer breadth over precision at this stage — compact summaries from extraction are cheap (~500-800 tokens each), and you decide which papers need deep reading later in Step 4.
4. Record why you kept each paper (one sentence) — this helps the Double-Check step later.

## Step 3: Full-Text Extraction & Indexing

1. For each relevant DOI from Step 2, call `grados:extract_paper_full_text`. **Always pass `expected_title`** (the paper's title from the search results) so the server can validate the extracted content.
   - If `papers/{safe_doi}.md` already exists (from a previous query or the local library), skip re-extraction for that DOI.
2. Successfully extracted papers are automatically saved as `.md` files to the `papers/` directory.
3. **The tool returns a compact, non-citable summary** (title, DOI, canonical path/URI, short preview, section headings), NOT the full text. Full text is saved to `papers/{safe_doi}.md`.
4. In Step 4, use **`grados:read_saved_paper`** as the canonical deep-reading path. If your client supports MCP resource reading, you may alternatively read `grados://papers/{safe_doi}` directly.
5. After each successful extraction, call `local-rag:ingest_file` on the saved `.md` file to index it for future reuse. The file path follows the pattern: `papers/{safe_doi}.md` where `safe_doi` replaces non-alphanumeric characters with `_`.
   - **Only ingest `.md` files**, never `.pdf` — this prevents duplicate content in the vector database.
6. **If extraction fails** (the tool returns an error):
   - If the paper seemed **strongly relevant** based on its abstract, record it in a failed-extraction section at the end of your report, including its title, DOI, and abstract summary.
   - If the paper was only marginally relevant, silently skip it.
7. **Do NOT attempt to extract more than 8 papers** in a single query to conserve API quota and time.

## Step 3b: Browser-Assisted Extraction (Playwright MCP Fallback)

If `extract_paper_full_text` fails for a strongly relevant paper (returns error about paywall or headless failure), and you have **Playwright MCP** (`@playwright/mcp`) tools available, attempt browser-assisted extraction:

1. Call `browser_navigate` to `https://doi.org/{doi}` to open the publisher page.
2. Call `browser_snapshot` to view the page structure (accessibility tree). Look for PDF download links or buttons.
3. Call `browser_click` on the most likely PDF download element (e.g., "Download PDF", "View PDF", "Full Text PDF"). Use the accessibility tree to identify the correct element — this is the key advantage over hardcoded selectors.
4. If the click triggers a file download, Playwright MCP automatically saves it. Note the downloaded file path from the tool response.
5. If you encounter a CAPTCHA or Cloudflare challenge, call `browser_take_screenshot` to see the current state. Report to the user that manual intervention may be needed.
6. Once the PDF is downloaded, call `grados:parse_pdf_file` with the downloaded file path and the paper's DOI and title. This parses the PDF and saves the Markdown to `papers/` for RAG indexing.

> If Playwright MCP tools are not available, skip this step. The paper will be recorded in the "未能获取全文" section.

## Step 4: Information Synthesis, Citation & Zotero

1. For each paper you plan to cite, call **`grados:read_saved_paper`** to load canonical full text from the saved papers store. Prioritize papers whose compact summaries (from Step 3) appear most relevant to the user's question. Focus on the **3-5 most relevant papers** for deep reading — you do not need to read every extracted paper.
   - You may identify a paper by `doi`, `safe_doi`, or `grados://papers/{safe_doi}`.
   - **Do NOT synthesize from the compact summaries** in your tool output history — they are explicitly non-citable and insufficient for accurate citation.
   - If your client supports MCP resources, `grados://papers/{safe_doi}` is the canonical read-only resource mirror of the same saved Markdown.
   - If your context has been compacted, earlier tool outputs may be gone entirely. The saved paper files and canonical paper resources are your authoritative source.
   - Also incorporate any relevant content from the local library (Step 0).
2. Synthesize an answer to the user's original question **in Chinese**.
3. **Citation rule**: Every factual claim MUST include an inline citation, e.g. `[Smith et al., 2023]`. Only cite content you have actually **Read from a paper file** in this session. No unsupported claims allowed.
4. After completing the synthesis, for each paper that was **actually cited** in the answer, call `grados:save_paper_to_zotero` with its full metadata (title, DOI, authors, abstract, journal, year, url, tags). Pass the query topic as a tag so papers are organised by research theme.
   - Only save papers that contributed to the final answer — do not save papers that were screened out or failed extraction.
   - If `grados:save_paper_to_zotero` returns an error (e.g. Zotero not configured), silently skip and continue.

## Step 5: Double-Check Protocol (CRITICAL)

> If earlier tool outputs have been compressed or truncated by the harness, re-call `grados:read_saved_paper` (or re-read the canonical paper resource) before verifying claims. Never verify a claim against your memory of a paper — verify against the actual saved paper content.

Before presenting your final answer:

1. Re-examine every claim in your synthesis.
2. For each claim, use **`grados:read_saved_paper`** to verify that the actual saved paper content supports it. Do not rely on your memory of the paper or stale context.
3. **Delete** any claim not explicitly supported by the extracted papers.
4. If the papers don't fully answer the question, state clearly in Chinese that the retrieved literature does not cover the specific aspect, and specify what it does cover.
5. Do **NOT** fill gaps with pre-trained knowledge. Only cite what you extracted and verified from files.

## Output Format

```
## 摘要
[从详细分析中提炼的摘要说明]

## 详细分析
[基于论文证据的分段分析，每个事实标注引用]

## 参考文献
1. Author et al. (Year). "Title". DOI: xxx [来源: 本地库 / GRaDOS提取]
2. ...

## 未能获取全文（如有）
- "Paper Title" (DOI: xxx) — 摘要表明该论文可能包含相关信息，但全文提取失败。
```
