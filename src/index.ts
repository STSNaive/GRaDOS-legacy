#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    ListToolsRequestSchema, CallToolRequestSchema,
    ListResourcesRequestSchema, ReadResourceRequestSchema,
    ListResourceTemplatesRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import axios from "axios";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import * as cheerio from 'cheerio';
import puppeteerVanilla from 'puppeteer-core';
import { addExtra } from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import FormData from 'form-data';
import { PDFParse } from 'pdf-parse';
import { spawn } from 'node:child_process';
import {
    runResumableSearch,
    type PaperMetadata,
    type SearchSourceAdapter,
    type SearchSourceName,
    type SearchSourcePage,
    type SearchSourceState
} from "./resumable-search.js";

const puppeteer = addExtra(puppeteerVanilla as any);
puppeteer.use(StealthPlugin());

// --- Path Resolution ---
// PACKAGE_ROOT: where grados is installed (contains marker-worker/, grados-config.example.json, etc.)
// In dist/index.js, __dirname is <install>/dist, so the package root is one level up.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

function readPackageVersion(): string {
    try {
        const packageJsonPath = path.join(PACKAGE_ROOT, "package.json");
        const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf-8"));
        if (typeof packageJson.version === "string" && packageJson.version.length > 0) {
            return packageJson.version;
        }
    } catch {
        // Fall through to the conservative fallback below.
    }
    return "0.0.0";
}

const GRADOS_VERSION = readPackageVersion();

function readLocalEnvFile(filePath: string): Record<string, string> {
    const values: Record<string, string> = {};

    try {
        const content = fs.readFileSync(filePath, "utf-8");
        for (const rawLine of content.split(/\r?\n/)) {
            const line = rawLine.trim();
            if (!line || line.startsWith("#")) continue;
            const separatorIndex = line.indexOf("=");
            if (separatorIndex === -1) continue;

            const key = line.slice(0, separatorIndex).trim();
            const value = line.slice(separatorIndex + 1).trim();
            if (key) {
                values[key] = value;
            }
        }
    } catch {
        // Marker installation metadata is optional.
    }

    return values;
}

function resolveMarkerPython(workerDir: string): string | null {
    const localEnvPath = path.join(workerDir, "local.env");
    const localEnv = readLocalEnvFile(localEnvPath);
    const configuredPython = localEnv.MARKER_PYTHON;

    if (configuredPython) {
        const resolvedConfiguredPython = path.isAbsolute(configuredPython)
            ? configuredPython
            : path.resolve(workerDir, configuredPython);
        if (fs.existsSync(resolvedConfiguredPython)) {
            return resolvedConfiguredPython;
        }
        console.error(`   [Marker] Configured interpreter not found: ${resolvedConfiguredPython}`);
    }

    const fallbackCandidates = [
        path.join(workerDir, ".venv", "bin", "python"),
        path.join(workerDir, ".venv", "bin", "python3"),
        path.join(workerDir, ".venv", "Scripts", "python.exe"),
        path.join(workerDir, ".venv", "Scripts", "python"),
    ];

    for (const candidate of fallbackCandidates) {
        if (fs.existsSync(candidate)) {
            return candidate;
        }
    }

    return null;
}

function handleCliFlags(): void {
    if (process.argv.includes("--version") || process.argv.includes("-v")) {
        console.log(GRADOS_VERSION);
        process.exit(0);
    }

    if (process.argv.includes("--init")) {
        const exampleSrc = path.join(PACKAGE_ROOT, "grados-config.example.json");
        const destPath = path.join(process.cwd(), "grados-config.json");

        if (fs.existsSync(destPath)) {
            console.log("grados-config.json already exists in this directory. No changes made.");
        } else if (!fs.existsSync(exampleSrc)) {
            console.error("Could not find grados-config.example.json in the package. Please create grados-config.json manually.");
            process.exitCode = 1;
        } else {
            fs.copyFileSync(exampleSrc, destPath);
            console.log(`Created grados-config.json in ${process.cwd()}`);
            console.log("Edit this file to add your API keys and configure GRaDOS.");
        }
        process.exit();
    }
}

handleCliFlags();

dotenv.config();

// Apply a stealthy global User-Agent to evade basic 403 Forbidden blocks
axios.defaults.headers.common['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// Resolve config file path: --config <path> > GRADOS_CONFIG_PATH env > cwd/grados-config.json
function resolveConfigPath(): string {
    const argIdx = process.argv.indexOf("--config");
    if (argIdx !== -1 && process.argv[argIdx + 1]) {
        return path.resolve(process.argv[argIdx + 1]);
    }
    if (process.env.GRADOS_CONFIG_PATH) {
        return path.resolve(process.env.GRADOS_CONFIG_PATH);
    }
    return path.join(process.cwd(), "grados-config.json");
}

const CONFIG_PATH = resolveConfigPath();

// PROJECT_ROOT: directory containing the config file. All user-project relative paths
// (papers/, downloads/, mirror store) resolve against this, NOT process.cwd().
const PROJECT_ROOT = path.dirname(CONFIG_PATH);

// Load Configuration
let config: any = {};
try {
    if (fs.existsSync(CONFIG_PATH)) {
        config = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8"));
        console.error(`[GRaDOS] Loaded config from: ${CONFIG_PATH}`);
    }
} catch (e) {
    console.error(`Failed to load config from ${CONFIG_PATH}. Falling back to default env variables.`, e);
}

// Inject API keys from config into process.env (single config file as source of truth)
if (config?.apiKeys) {
    for (const [key, value] of Object.entries(config.apiKeys)) {
        if (value && typeof value === 'string' && value.length > 0) {
            process.env[key] = value;
        }
    }
}

// Warn if academic etiquette email is still the default placeholder
if (!config.academicEtiquetteEmail || config.academicEtiquetteEmail === "admin@example.com") {
    console.error("[GRaDOS] WARNING: academicEtiquetteEmail is not configured. Crossref/Unpaywall may throttle requests. Set a real email in grados-config.json.");
}

// Helpers to get API keys (Config file overrides .env, which is the MCPB path)
const getApiKey = (keyName: string) => config?.apiKeys?.[keyName] || process.env[keyName];
const getEtiquetteEmail = () => config?.academicEtiquetteEmail || process.env.ACADEMIC_ETIQUETTE_EMAIL || "admin@example.com";

// Initialize Server
const server = new Server(
    {
        name: "GRaDOS",
        version: GRADOS_VERSION,
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
    }
);

type JsonSchema = Record<string, unknown>;

interface ToolRegistryEntry {
    name: string;
    description: string;
    purpose: string;
    returns: string;
    commonFailures: string[];
    inputSchema: JsonSchema;
    outputSchema?: JsonSchema;
}

interface PaperSavedSummary {
    kind: "paper_saved_summary";
    doi: string;
    safe_doi: string;
    title: string;
    source: string;
    relative_path: string;
    absolute_path: string;
    canonical_uri: string;
    word_count: number;
    char_count: number;
    preview_excerpt: string;
    section_headings: string[];
    full_text_saved: true;
    read_required_for_citation: true;
    preview_not_citable: true;
}

interface PaperReadResult {
    kind: "paper_read_result";
    doi: string;
    safe_doi: string;
    title: string;
    canonical_uri: string;
    relative_path: string;
    absolute_path: string;
    start_paragraph: number;
    returned_paragraphs: number;
    section_query?: string;
    truncated: boolean;
    citation_ready: true;
    content_text: string;
}

interface PaperIndexEntry {
    doi: string;
    safe_doi: string;
    title: string;
    canonical_uri: string;
    relative_path: string;
    absolute_path: string;
    last_modified: string;
}

const PAPER_METADATA_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        title: { type: "string" },
        doi: { type: "string" },
        abstract: { type: "string" },
        publisher: { type: "string" },
        authors: { type: "array", items: { type: "string" } },
        year: { type: "string" },
        url: { type: "string" },
        source: { type: "string" }
    },
    required: ["title", "doi", "source"],
    additionalProperties: false
};

const SEARCH_SOURCE_NAME_SCHEMA: JsonSchema = {
    type: "string",
    enum: ["Elsevier", "Springer", "WebOfScience", "Crossref", "PubMed"]
};

const SEARCH_INPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "The search query (e.g., 'large language models in multi-agent reinforcement learning')."
        },
        limit: {
            type: "number",
            description: "Maximum number of results to return (default: 15).",
            default: 15
        },
        continuation_token: {
            type: "string",
            description: "Opaque token returned by a previous search_academic_papers call. Reuse it with the same query to continue fetching new papers without repeats."
        }
    },
    required: ["query"],
    additionalProperties: false
};

const SEARCH_OUTPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        query: { type: "string" },
        limit: { type: "number" },
        results: {
            type: "array",
            items: PAPER_METADATA_SCHEMA
        },
        has_more: {
            type: "boolean"
        },
        exhausted_sources: {
            type: "array",
            items: SEARCH_SOURCE_NAME_SCHEMA
        },
        next_continuation_token: {
            type: "string"
        },
        warnings: {
            type: "array",
            items: { type: "string" }
        },
        continuation_applied: {
            type: "boolean"
        }
    },
    required: ["query", "limit", "results", "has_more", "exhausted_sources", "warnings", "continuation_applied"],
    additionalProperties: false
};

const PAPER_SAVED_SUMMARY_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        kind: { type: "string", const: "paper_saved_summary" },
        doi: { type: "string" },
        safe_doi: { type: "string" },
        title: { type: "string" },
        source: { type: "string" },
        relative_path: { type: "string" },
        absolute_path: { type: "string" },
        canonical_uri: { type: "string" },
        word_count: { type: "number" },
        char_count: { type: "number" },
        preview_excerpt: { type: "string" },
        section_headings: { type: "array", items: { type: "string" } },
        full_text_saved: { type: "boolean", const: true },
        read_required_for_citation: { type: "boolean", const: true },
        preview_not_citable: { type: "boolean", const: true }
    },
    required: [
        "kind",
        "doi",
        "safe_doi",
        "title",
        "source",
        "relative_path",
        "absolute_path",
        "canonical_uri",
        "word_count",
        "char_count",
        "preview_excerpt",
        "section_headings",
        "full_text_saved",
        "read_required_for_citation",
        "preview_not_citable"
    ],
    additionalProperties: false
};

const PAPER_READ_RESULT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        kind: { type: "string", const: "paper_read_result" },
        doi: { type: "string" },
        safe_doi: { type: "string" },
        title: { type: "string" },
        canonical_uri: { type: "string" },
        relative_path: { type: "string" },
        absolute_path: { type: "string" },
        start_paragraph: { type: "number" },
        returned_paragraphs: { type: "number" },
        section_query: { type: "string" },
        truncated: { type: "boolean" },
        citation_ready: { type: "boolean", const: true },
        content_text: { type: "string" }
    },
    required: [
        "kind",
        "doi",
        "safe_doi",
        "title",
        "canonical_uri",
        "relative_path",
        "absolute_path",
        "start_paragraph",
        "returned_paragraphs",
        "truncated",
        "citation_ready",
        "content_text"
    ],
    additionalProperties: false
};

const EXTRACT_INPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        doi: {
            type: "string",
            description: "The Digital Object Identifier (DOI) of the paper."
        },
        publisher: {
            type: "string",
            description: "The publisher name, if known (e.g., 'Elsevier', 'Springer'), to optimize extraction strategy."
        },
        expected_title: {
            type: "string",
            description: "The title of the paper. Used for QA validation to ensure the extracted text matches the requested paper."
        }
    },
    required: ["doi"],
    additionalProperties: false
};

const PARSE_PDF_INPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        file_path: {
            type: "string",
            description: "Path to the local PDF file. Absolute paths are used as-is; relative paths are resolved from PROJECT_ROOT (the config file's directory)."
        },
        expected_title: {
            type: "string",
            description: "Expected paper title for QA validation. If provided, the parsed text is checked to contain this title."
        },
        doi: {
            type: "string",
            description: "DOI of the paper. If provided, the parsed Markdown is saved to the papers directory with front-matter."
        }
    },
    required: ["file_path"],
    additionalProperties: false
};

const READ_SAVED_PAPER_INPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        doi: {
            type: "string",
            description: "DOI of the saved paper to read."
        },
        safe_doi: {
            type: "string",
            description: "Sanitized DOI filename token (non-alphanumeric characters replaced with underscores)."
        },
        uri: {
            type: "string",
            description: "Canonical resource URI in the form grados://papers/{safe_doi}."
        },
        start_paragraph: {
            type: "number",
            description: "Paragraph offset to start reading from (default: 0).",
            default: 0
        },
        max_paragraphs: {
            type: "number",
            description: "Maximum number of paragraphs to return (default: 20).",
            default: 20
        },
        section_query: {
            type: "string",
            description: "Optional section heading query. If provided, GRaDOS finds the closest matching section and returns a paragraph window from there."
        },
        include_front_matter: {
            type: "boolean",
            description: "Whether to include YAML front-matter in the returned text (default: false).",
            default: false
        }
    },
    additionalProperties: false
};

const ZOTERO_SAVE_INPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        doi: {
            type: "string",
            description: "The DOI of the paper."
        },
        title: {
            type: "string",
            description: "The full title of the paper."
        },
        authors: {
            type: "array",
            items: { type: "string" },
            description: "List of author names (e.g. ['Jane Smith', 'John Doe'])."
        },
        abstract: {
            type: "string",
            description: "The abstract of the paper."
        },
        journal: {
            type: "string",
            description: "Journal or publisher name."
        },
        year: {
            type: "string",
            description: "Publication year (e.g. '2023')."
        },
        url: {
            type: "string",
            description: "URL to the paper's landing page."
        },
        tags: {
            type: "array",
            items: { type: "string" },
            description: "Optional tags/keywords to attach to the Zotero item."
        },
        collection_key: {
            type: "string",
            description: "Optional Zotero collection key to file the item into. Overrides zotero.defaultCollectionKey from config."
        }
    },
    required: ["doi", "title"],
    additionalProperties: false
};

const ZOTERO_SAVE_OUTPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        success: { type: "boolean" },
        doi: { type: "string" },
        title: { type: "string" },
        item_key: { type: "string" },
        error: { type: "string" }
    },
    required: ["success", "doi", "title"],
    additionalProperties: false
};

const TOOL_REGISTRY: ToolRegistryEntry[] = [
    {
        name: "search_academic_papers",
        description: "Searches multiple academic databases sequentially in priority order (Crossref, PubMed, WoS, Elsevier, Springer) for a given query and returns a deduplicated list of papers with metadata (DOIs, Abstracts). Supports resumable continuation via continuation_token.",
        purpose: "Search academic databases and return deduplicated paper metadata, with optional continuation for fetching more unseen papers later",
        returns: "Structured paper metadata plus resumable-search metadata and a markdown-formatted screening list.",
        commonFailures: ["No API key for a specific database (gracefully skipped)", "Network timeout", "Database rate limiting", "Invalid or mismatched continuation_token"],
        inputSchema: SEARCH_INPUT_SCHEMA,
        outputSchema: SEARCH_OUTPUT_SCHEMA
    },
    {
        name: "extract_paper_full_text",
        description: "Given a DOI, attempts to fetch the full text of the paper using a waterfall strategy. Saves full text to papers/{safe_doi}.md and returns a compact, non-citable summary with canonical paths and URI. Use read_saved_paper or the paper resource to access the full text when needed. Includes QA validation to ensure it's not a paywall.",
        purpose: "Fetch full-text paper content by DOI, save it to disk, and return a canonical saved-paper summary",
        returns: "PaperSavedSummary with canonical path, URI, preview excerpt, and section headings.",
        commonFailures: ["Paywall blocks all strategies", "PDF parsing fails", "QA validation rejects truncated content", "Saved markdown file could not be written"],
        inputSchema: EXTRACT_INPUT_SCHEMA,
        outputSchema: PAPER_SAVED_SUMMARY_SCHEMA
    },
    {
        name: "parse_pdf_file",
        description: "Parses a local PDF file using the configured parsing waterfall (LlamaParse → Marker → Native). Use this when you have already downloaded a PDF (e.g., via Playwright MCP browser automation) and need GRaDOS to parse it. If a DOI is provided, the parsed Markdown is saved to the papers directory with YAML front-matter and returned as a canonical saved-paper summary.",
        purpose: "Parse a local PDF file and optionally save it into the canonical papers store",
        returns: "Full parsed text for ad-hoc PDFs, or PaperSavedSummary when DOI-backed saving is requested.",
        commonFailures: ["File not found", "Not a valid PDF", "All parsers fail", "QA validation rejects content", "Saved markdown file could not be written"],
        inputSchema: PARSE_PDF_INPUT_SCHEMA
    },
    {
        name: "read_saved_paper",
        description: "Reads a previously saved paper from papers/{safe_doi}.md. This is the canonical deep-reading tool for synthesis and citation verification. It supports DOI, safe_doi, or grados://papers/{safe_doi} identifiers plus paragraph windows and section queries.",
        purpose: "Read canonical paper markdown from the saved papers store for synthesis and citation checking",
        returns: "PaperReadResult with the canonical URI, resolved paths, paragraph window metadata, and returned text.",
        commonFailures: ["Identifier is missing or ambiguous", "Requested paper file does not exist", "URI is not a valid grados paper URI"],
        inputSchema: READ_SAVED_PAPER_INPUT_SCHEMA,
        outputSchema: PAPER_READ_RESULT_SCHEMA
    },
    {
        name: "save_paper_to_zotero",
        description: "Saves a paper's bibliographic metadata to the Zotero web library. Call this after synthesis for each paper that was cited in the final answer. Requires ZOTERO_API_KEY and zotero.libraryId in grados-config.json.",
        purpose: "Save cited paper metadata to the Zotero web library",
        returns: "Structured success/error status with the Zotero item key when available.",
        commonFailures: ["ZOTERO_API_KEY not configured", "libraryId not set", "Network error"],
        inputSchema: ZOTERO_SAVE_INPUT_SCHEMA,
        outputSchema: ZOTERO_SAVE_OUTPUT_SCHEMA
    }
];

const STATIC_RESOURCE_DEFINITIONS = [
    {
        uri: "grados://about",
        name: "GRaDOS About",
        description: "Service overview: name, version, capabilities, and available tools",
        mimeType: "application/json"
    },
    {
        uri: "grados://status",
        name: "GRaDOS Status",
        description: "Health check: config loaded, directories exist, API keys configured",
        mimeType: "application/json"
    },
    {
        uri: "grados://tools",
        name: "GRaDOS Tools",
        description: "Read-only mirror of available tools with names, descriptions, and schemas",
        mimeType: "application/json"
    },
    {
        uri: "grados://papers/index",
        name: "GRaDOS Papers Index",
        description: "Lightweight index of saved markdown papers in the configured papers directory",
        mimeType: "application/json"
    }
] as const;

const PAPER_RESOURCE_TEMPLATE = {
    uriTemplate: "grados://papers/{safe_doi}",
    name: "GRaDOS Saved Paper",
    description: "Canonical full-text markdown resource for a saved paper",
    mimeType: "text/markdown"
};

function buildToolListEntries() {
    return TOOL_REGISTRY.map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {})
    }));
}

function buildToolMirrorEntries() {
    return TOOL_REGISTRY.map((tool) => ({
        name: tool.name,
        description: tool.description,
        purpose: tool.purpose,
        inputSchema: tool.inputSchema,
        ...(tool.outputSchema ? { outputSchema: tool.outputSchema } : {}),
        returns: tool.returns,
        commonFailures: tool.commonFailures
    }));
}

interface WebOfScienceSearchState extends SearchSourceState {
    page: number;
    pageSize: number;
}

interface ElsevierSearchState extends SearchSourceState {
    start: number;
    pageSize: number;
}

interface SpringerSearchState extends SearchSourceState {
    fetched: boolean;
    pageSize: number;
}

interface CrossrefSearchState extends SearchSourceState {
    cursor: string;
    rows: number;
    pagesFetched: number;
    cursorIssuedAt: string;
}

interface PubMedSearchState extends SearchSourceState {
    retstart: number;
    pageSize: number;
    totalCount?: number;
}

function clampSearchPageSize(limit: number, maxPageSize: number): number {
    if (!Number.isFinite(limit) || limit <= 0) return Math.min(15, maxPageSize);
    return Math.max(1, Math.min(Math.floor(limit), maxPageSize));
}

function filterPapersWithDoi(papers: PaperMetadata[]): PaperMetadata[] {
    return papers.filter((paper) => typeof paper.doi === "string" && paper.doi.trim().length > 0);
}

async function searchWebOfSciencePage(params: {
    query: string;
    limit: number;
    state: SearchSourceState;
}): Promise<SearchSourcePage> {
    const apiKey = getApiKey("WOS_API_KEY");
    if (!apiKey) {
        return {
            papers: [],
            nextState: params.state,
            exhausted: true,
            warnings: ["WebOfScience search skipped: WOS_API_KEY not configured."]
        };
    }

    const state = params.state as unknown as WebOfScienceSearchState;
    const page = Number.isFinite(state.page) && state.page > 0 ? Math.floor(state.page) : 1;
    const pageSize = clampSearchPageSize(state.pageSize ?? params.limit, 50);

    try {
        const response = await axios.get("https://api.clarivate.com/apis/wos-starter/v1/documents", {
            params: { q: `TS=(${params.query})`, page, limit: pageSize },
            headers: { "X-ApiKey": apiKey }
        });
        const hits = response.data?.hits || [];
        const totalResults = Number(response.data?.metadata?.total || 0);
        const papers = filterPapersWithDoi(hits.map((hit: any) => ({
            title: hit.title || "Unknown Title",
            doi: hit.identifiers?.doi || "",
            abstract: hit.abstract,
            publisher: hit.source?.sourceTitle,
            authors: hit.names?.authors ? hit.names.authors.map((a: any) => a.displayName) : [],
            year: hit.source?.publishYear?.toString(),
            url: hit.links?.record,
            source: "Web of Science"
        })));

        const exhausted = hits.length === 0
            || hits.length < pageSize
            || (totalResults > 0 && page * pageSize >= totalResults);

        return {
            papers,
            nextState: { page: page + 1, pageSize },
            exhausted
        };
    } catch (e) {
        console.error("WoS search failed", e);
        return {
            papers: [],
            nextState: state,
            exhausted: true,
            warnings: ["WebOfScience search failed; that source has been marked exhausted for this continuation flow."]
        };
    }
}

async function searchElsevierPage(params: {
    query: string;
    limit: number;
    state: SearchSourceState;
}): Promise<SearchSourcePage> {
    const apiKey = getApiKey("ELSEVIER_API_KEY");
    if (!apiKey) {
        return {
            papers: [],
            nextState: params.state,
            exhausted: true,
            warnings: ["Elsevier search skipped: ELSEVIER_API_KEY not configured."]
        };
    }

    const state = params.state as unknown as ElsevierSearchState;
    const start = Number.isFinite(state.start) && state.start >= 0 ? Math.floor(state.start) : 0;
    const pageSize = clampSearchPageSize(state.pageSize ?? params.limit, 25);

    try {
        const response = await axios.get("https://api.elsevier.com/content/search/scopus", {
            params: { query: params.query, count: pageSize, start, view: "COMPLETE" },
            headers: { "X-ELS-APIKey": apiKey, "Accept": "application/json" }
        });
        const entries = response.data?.["search-results"]?.entry || [];
        const totalResults = Number(response.data?.["search-results"]?.["opensearch:totalResults"] || 0);
        const papers = filterPapersWithDoi(entries.map((item: any) => ({
            title: item["dc:title"] || "Unknown Title",
            doi: item["prism:doi"],
            abstract: item["dc:description"],
            publisher: item["prism:publicationName"],
            authors: item.author ? item.author.map((a: any) => a.authname) : [],
            year: item["prism:coverDate"]?.split("-")?.[0],
            url: item["prism:url"],
            source: "Elsevier (Scopus)"
        })));

        const exhausted = entries.length === 0
            || entries.length < pageSize
            || (totalResults > 0 && start + pageSize >= totalResults);

        return {
            papers,
            nextState: { start: start + pageSize, pageSize },
            exhausted
        };
    } catch (e) {
        console.error("Elsevier search failed", e);
        return {
            papers: [],
            nextState: state,
            exhausted: true,
            warnings: ["Elsevier search failed; that source has been marked exhausted for this continuation flow."]
        };
    }
}

async function searchSpringerPage(params: {
    query: string;
    limit: number;
    state: SearchSourceState;
}): Promise<SearchSourcePage> {
    const apiKey = getApiKey("SPRINGER_meta_API_KEY");
    if (!apiKey) {
        return {
            papers: [],
            nextState: params.state,
            exhausted: true,
            warnings: ["Springer search skipped: SPRINGER_meta_API_KEY not configured."]
        };
    }

    const state = params.state as unknown as SpringerSearchState;
    if (state.fetched) {
        return {
            papers: [],
            nextState: state,
            exhausted: true
        };
    }

    const pageSize = clampSearchPageSize(state.pageSize ?? params.limit, 50);
    try {
        const response = await axios.get("https://api.springernature.com/meta/v2/json", {
            params: { q: `keyword:"${params.query}"`, p: pageSize, api_key: apiKey }
        });
        const records = response.data?.records || [];
        const papers = filterPapersWithDoi(records.map((item: any) => ({
            title: item.title || "Unknown Title",
            doi: item.doi,
            abstract: item.abstract,
            publisher: item.publisher,
            authors: item.creators ? item.creators.map((c: any) => c.creator) : [],
            year: item.publicationDate?.split("-")?.[0],
            url: item.url?.[0]?.value,
            source: "Springer Nature"
        })));

        return {
            papers,
            nextState: { fetched: true, pageSize },
            exhausted: true,
            warnings: [
                "Springer continuation currently uses a conservative single-page strategy until its latest public pagination contract is re-verified."
            ]
        };
    } catch (e) {
        console.error("Springer search failed", e);
        return {
            papers: [],
            nextState: { fetched: true, pageSize },
            exhausted: true,
            warnings: ["Springer search failed; that source has been marked exhausted for this continuation flow."]
        };
    }
}

async function searchCrossrefPage(params: {
    query: string;
    limit: number;
    state: SearchSourceState;
    now: Date;
}): Promise<SearchSourcePage> {
    const state = params.state as unknown as CrossrefSearchState;
    const cursor = typeof state.cursor === "string" && state.cursor.length > 0 ? state.cursor : "*";
    const rows = clampSearchPageSize(state.rows ?? params.limit, 100);

    try {
        const etiquetteEmail = getEtiquetteEmail();
        const response = await axios.get("https://api.crossref.org/works", {
            params: {
                query: params.query,
                rows,
                cursor,
                select: "DOI,title,abstract,publisher,author,published-print,URL"
            },
            headers: {
                "User-Agent": `GRaDOS/1.0 (mailto:${etiquetteEmail}) Mozilla/5.0 Chrome/120.0.0.0`
            }
        });

        const items = response.data?.message?.items || [];
        const nextCursor = response.data?.message?.["next-cursor"];
        const papers = filterPapersWithDoi(items.map((item: any) => ({
            title: item.title?.[0] || "Unknown Title",
            doi: item.DOI,
            abstract: item.abstract ? item.abstract.replace(/(<([^>]+)>)/gi, "") : undefined,
            publisher: item.publisher,
            authors: item.author?.map((a: any) => `${a.given} ${a.family}`),
            year: item["published-print"]?.["date-parts"]?.[0]?.[0]?.toString(),
            url: item.URL,
            source: "Crossref"
        })));

        return {
            papers,
            nextState: {
                cursor: typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : cursor,
                rows,
                pagesFetched: (Number.isFinite(state.pagesFetched) ? Number(state.pagesFetched) : 0) + 1,
                cursorIssuedAt: params.now.toISOString()
            },
            exhausted: items.length === 0 || items.length < rows || !nextCursor
        };
    } catch (e) {
        console.error("Crossref search failed", e);
        return {
            papers: [],
            nextState: state,
            exhausted: true,
            warnings: ["Crossref search failed; that source has been marked exhausted for this continuation flow."]
        };
    }
}

async function searchPubMedPage(params: {
    query: string;
    limit: number;
    state: SearchSourceState;
}): Promise<SearchSourcePage> {
    const state = params.state as unknown as PubMedSearchState;
    const retstart = Number.isFinite(state.retstart) && state.retstart >= 0 ? Math.floor(state.retstart) : 0;
    const pageSize = clampSearchPageSize(state.pageSize ?? params.limit, 100);

    try {
        const searchRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", {
            params: {
                db: "pubmed",
                term: params.query,
                retmode: "json",
                retstart,
                retmax: pageSize
            }
        });
        const pmids = searchRes.data?.esearchresult?.idlist;
        const totalCount = Number(searchRes.data?.esearchresult?.count || state.totalCount || 0);
        if (!pmids || pmids.length === 0) {
            return {
                papers: [],
                nextState: { retstart, pageSize, totalCount },
                exhausted: true
            };
        }

        const summaryRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", {
            params: {
                db: "pubmed",
                id: pmids.join(","),
                retmode: "json"
            }
        });

        const abstractMap = new Map<string, string>();
        try {
            const fetchRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/efetch.fcgi", {
                params: {
                    db: "pubmed",
                    id: pmids.join(","),
                    rettype: "xml",
                    retmode: "xml"
                }
            });
            const xml: string = fetchRes.data;
            const articleBlocks = xml.split(/<PubmedArticle>/g).slice(1);
            for (const block of articleBlocks) {
                const pmidMatch = block.match(/<PMID[^>]*>(\d+)<\/PMID>/);
                const abstractMatch = block.match(/<Abstract>([\s\S]*?)<\/Abstract>/);
                if (!pmidMatch || !abstractMatch) continue;

                const rawAbstract = abstractMatch[1]
                    .replace(/<\/?AbstractText[^>]*>/g, " ")
                    .replace(/<[^>]+>/g, "")
                    .replace(/\s+/g, " ")
                    .trim();
                if (rawAbstract.length > 0) {
                    abstractMap.set(pmidMatch[1], rawAbstract);
                }
            }
        } catch (e) {
            console.error("PubMed EFetch for abstracts failed, continuing without abstracts.", e);
        }

        const resultDict = summaryRes.data?.result || {};
        const papers: PaperMetadata[] = [];
        for (const pmid of pmids) {
            const paper = resultDict[pmid];
            if (!paper) continue;

            const articleIds = paper.articleids || [];
            const doiObj = articleIds.find((idObj: any) => idObj.idtype === "doi");
            const doi = doiObj?.value || "";
            if (!doi) continue;

            papers.push({
                title: paper.title,
                doi,
                abstract: abstractMap.get(pmid),
                publisher: paper.fulljournalname,
                authors: paper.authors?.map((a: any) => a.name),
                year: paper.pubdate?.split(" ")?.[0],
                url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
                source: "PubMed"
            });
        }

        return {
            papers,
            nextState: { retstart: retstart + pageSize, pageSize, totalCount },
            exhausted: pmids.length === 0 || pmids.length < pageSize || (totalCount > 0 && retstart + pageSize >= totalCount)
        };
    } catch (e) {
        console.error("PubMed search failed", e);
        return {
            papers: [],
            nextState: state,
            exhausted: true,
            warnings: ["PubMed search failed; that source has been marked exhausted for this continuation flow."]
        };
    }
}

function buildSearchAdapters(): Partial<Record<SearchSourceName, SearchSourceAdapter>> {
    return {
        WebOfScience: {
            initializeState: ({ limit }) => ({ page: 1, pageSize: clampSearchPageSize(limit, 50) }),
            fetchPage: ({ query, limit, state }) => searchWebOfSciencePage({ query, limit, state })
        },
        Elsevier: {
            initializeState: ({ limit }) => ({ start: 0, pageSize: clampSearchPageSize(limit, 25) }),
            fetchPage: ({ query, limit, state }) => searchElsevierPage({ query, limit, state })
        },
        Springer: {
            initializeState: ({ limit }) => ({ fetched: false, pageSize: clampSearchPageSize(limit, 50) }),
            fetchPage: ({ query, limit, state }) => searchSpringerPage({ query, limit, state })
        },
        Crossref: {
            initializeState: ({ limit, now }) => ({
                cursor: "*",
                rows: clampSearchPageSize(limit, 100),
                pagesFetched: 0,
                cursorIssuedAt: now.toISOString()
            }),
            fetchPage: ({ query, limit, state, now }) => searchCrossrefPage({ query, limit, state, now })
        },
        PubMed: {
            initializeState: ({ limit }) => ({ retstart: 0, pageSize: clampSearchPageSize(limit, 100) }),
            fetchPage: ({ query, limit, state }) => searchPubMedPage({ query, limit, state })
        }
    };
}

// Tool Listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: buildToolListEntries()
    };
});

// --- Helper: QA Validation ---
function isValidPaperContent(text: string, doi: string, minCharacters: number = 1500, expectedTitle?: string): boolean {
    if (!text || text.length < minCharacters) {
        console.error(`QA: Text too short (${text?.length ?? 0} < ${minCharacters}) for DOI: ${doi}`);
        return false;
    }

    // Check for Paywall / Error Anti-patterns
    const antiPatterns = ["purchase full access", "log in to view", "access provided by", "institution access required", "403 forbidden"];
    const lowerText = text.toLowerCase();
    for (const phrase of antiPatterns) {
        if (lowerText.includes(phrase)) {
            console.error(`QA: Paywall pattern detected ("${phrase}") for DOI: ${doi}`);
            return false;
        }
    }

    // Check for Academic Structure
    const structureRegex = /(abstract|introduction|methods|results|discussion|conclusion|references)/gi;
    const matches = text.match(structureRegex);
    if (!matches || matches.length < 2) {
        console.error(`QA: Lacks academic structure (found ${matches?.length ?? 0} section headers) for DOI: ${doi}`);
        return false;
    }

    // Verify title match if expected title is provided
    if (expectedTitle && expectedTitle.length > 10) {
        const normalizedExpected = expectedTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const normalizedText = lowerText.replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ');
        // Try full title first, then first 50 chars for partial match
        if (!normalizedText.includes(normalizedExpected)) {
            const shortTitle = normalizedExpected.substring(0, 50).trim();
            if (!normalizedText.includes(shortTitle)) {
                console.error(`QA: Title mismatch. Expected "${expectedTitle}" not found in extracted text for DOI: ${doi}`);
                return false;
            }
        }
    }

    return true;
}

function getPapersDirectory(): string {
    const papersDirectory = config?.extract?.papersDirectory;
    return papersDirectory ? path.resolve(PROJECT_ROOT, papersDirectory) : path.join(PROJECT_ROOT, "papers");
}

function getDownloadsDirectory(): string {
    const downloadDirectory = config?.extract?.downloadDirectory;
    return downloadDirectory ? path.resolve(PROJECT_ROOT, downloadDirectory) : path.join(PROJECT_ROOT, "downloads");
}

function safeDoiFromDoi(doi: string): string {
    return doi.replace(/[^a-z0-9]/gi, '_');
}

function buildPaperUri(safeDoi: string): string {
    return `grados://papers/${safeDoi}`;
}

function toProjectRelative(filePath: string): string {
    return path.relative(PROJECT_ROOT, filePath).split(path.sep).join('/');
}

function stripFrontMatter(text: string): string {
    return text.replace(/^---[\s\S]*?---\n*/, '');
}

function parseFrontMatter(text: string): Record<string, string> {
    const match = text.match(/^---\n([\s\S]*?)\n---\n?/);
    if (!match) return {};

    const metadata: Record<string, string> = {};
    for (const rawLine of match[1].split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;

        const separatorIndex = line.indexOf(':');
        if (separatorIndex === -1) continue;

        const key = line.slice(0, separatorIndex).trim();
        let value = line.slice(separatorIndex + 1).trim();
        if (value.startsWith('"') && value.endsWith('"')) {
            value = value.slice(1, -1).replace(/\\"/g, '"');
        }
        metadata[key] = value;
    }

    return metadata;
}

function normalizeComparable(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
}

function splitIntoParagraphs(text: string, includeFrontMatter: boolean = false): string[] {
    const content = includeFrontMatter ? text : stripFrontMatter(text);
    return content
        .split(/\n{2,}/)
        .map((paragraph) => paragraph.trim())
        .filter((paragraph) => paragraph.length > 0);
}

function extractSectionHeadings(text: string, maxHeadings: number = 12): string[] {
    const content = stripFrontMatter(text);
    const markdownHeadings = Array.from(content.matchAll(/^#{1,6}\s+(.+)$/gm))
        .map((match) => match[1].trim())
        .filter((heading) => heading.length > 0);

    if (markdownHeadings.length > 0) {
        return Array.from(new Set(markdownHeadings)).slice(0, maxHeadings);
    }

    const fallbackHeadings = Array.from(content.matchAll(/^(abstract|introduction|materials and methods|methods|results|discussion|conclusion|references)\s*$/gim))
        .map((match) => match[1].trim())
        .filter((heading) => heading.length > 0)
        .map((heading) => heading.replace(/\b\w/g, (char) => char.toUpperCase()));

    return Array.from(new Set(fallbackHeadings)).slice(0, maxHeadings);
}

function truncateText(text: string, maxChars: number): string {
    if (text.length <= maxChars) return text;
    return `${text.slice(0, maxChars - 3).trimEnd()}...`;
}

function extractPreviewExcerpt(text: string, maxChars: number = 1200): string {
    let content = stripFrontMatter(text);
    content = content.replace(/^#[^\n]*\n+/, '');
    const paragraphs = splitIntoParagraphs(content, true);
    if (paragraphs.length === 0) return "";
    return truncateText(paragraphs[0], maxChars);
}

function buildPaperResourceLink(summary: Pick<PaperSavedSummary, "canonical_uri" | "title">) {
    return {
        type: "resource_link",
        uri: summary.canonical_uri,
        name: summary.title,
        description: "Canonical saved paper markdown resource",
        mimeType: "text/markdown"
    };
}

function buildReadResourceLink(result: Pick<PaperReadResult, "canonical_uri" | "title">) {
    return {
        type: "resource_link",
        uri: result.canonical_uri,
        name: result.title,
        description: "Canonical saved paper markdown resource",
        mimeType: "text/markdown"
    };
}

function buildPaperSavedSummary(params: {
    doi: string;
    title?: string;
    source: string;
    text: string;
    absolutePath: string;
}): PaperSavedSummary {
    const safeDoi = safeDoiFromDoi(params.doi);
    const metadata = parseFrontMatter(params.text);
    const title = params.title || metadata.title || "(unknown)";

    return {
        kind: "paper_saved_summary",
        doi: params.doi,
        safe_doi: safeDoi,
        title,
        source: params.source,
        relative_path: toProjectRelative(params.absolutePath),
        absolute_path: params.absolutePath,
        canonical_uri: buildPaperUri(safeDoi),
        word_count: params.text.split(/\s+/).filter(Boolean).length,
        char_count: params.text.length,
        preview_excerpt: extractPreviewExcerpt(params.text),
        section_headings: extractSectionHeadings(params.text),
        full_text_saved: true,
        read_required_for_citation: true,
        preview_not_citable: true
    };
}

function buildPaperSavedSummaryText(summary: PaperSavedSummary): string {
    const headings = summary.section_headings.length > 0 ? summary.section_headings.join(" | ") : "(none detected)";
    return [
        `# Paper Saved Successfully [Source: ${summary.source}]`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Title** | ${summary.title} |`,
        `| **DOI** | ${summary.doi} |`,
        `| **File** | \`${summary.relative_path}\` |`,
        `| **URI** | \`${summary.canonical_uri}\` |`,
        `| **Length** | ${summary.word_count} words / ${summary.char_count} chars |`,
        ``,
        `## Preview (Not Citable)`,
        ``,
        summary.preview_excerpt || "(empty preview)",
        ``,
        `## Section Headings`,
        ``,
        headings,
        ``,
        `---`,
        `> Preview text is not citable. Use \`read_saved_paper\` or read \`${summary.canonical_uri}\` before synthesis or citation verification.`
    ].join('\n');
}

function buildPaperSavedSummaryResult(summary: PaperSavedSummary) {
    return {
        content: [
            {
                type: "text",
                text: buildPaperSavedSummaryText(summary)
            },
            buildPaperResourceLink(summary)
        ],
        structuredContent: summary
    };
}

function parsePaperUri(uri: string): string | null {
    const match = uri.match(/^grados:\/\/papers\/([A-Za-z0-9_]+)$/);
    return match?.[1] || null;
}

function resolvePaperLookup(args: any): { safeDoi: string; requestedBy: "doi" | "safe_doi" | "uri" } | { error: string } {
    const doi = args?.doi ? String(args.doi) : "";
    const safeDoi = args?.safe_doi ? String(args.safe_doi) : "";
    const uri = args?.uri ? String(args.uri) : "";
    const providedCount = [doi, safeDoi, uri].filter((value) => value.length > 0).length;

    if (providedCount !== 1) {
        return { error: "read_saved_paper requires exactly one of 'doi', 'safe_doi', or 'uri'." };
    }

    if (doi) return { safeDoi: safeDoiFromDoi(doi), requestedBy: "doi" };
    if (safeDoi) return { safeDoi, requestedBy: "safe_doi" };

    const parsedUri = parsePaperUri(uri);
    if (!parsedUri) {
        return { error: `Invalid paper URI: ${uri}. Expected grados://papers/{safe_doi}.` };
    }
    return { safeDoi: parsedUri, requestedBy: "uri" };
}

function readSavedPaperFileBySafeDoi(safeDoi: string): { absolutePath: string; text: string; metadata: Record<string, string> } | null {
    const absolutePath = path.join(getPapersDirectory(), `${safeDoi}.md`);
    if (!fs.existsSync(absolutePath)) return null;

    const text = fs.readFileSync(absolutePath, "utf-8");
    return {
        absolutePath,
        text,
        metadata: parseFrontMatter(text)
    };
}

function findParagraphWindowStart(paragraphs: string[], sectionQuery?: string): number {
    if (!sectionQuery) return 0;

    const normalizedQuery = normalizeComparable(sectionQuery);
    if (!normalizedQuery) return 0;

    const headingParagraphs = paragraphs.map((paragraph, index) => ({ paragraph, index }))
        .filter(({ paragraph }) => /^#{1,6}\s+/.test(paragraph));

    const exactHeadingMatch = headingParagraphs.find(({ paragraph }) => normalizeComparable(paragraph.replace(/^#{1,6}\s+/, '')) === normalizedQuery);
    if (exactHeadingMatch) return exactHeadingMatch.index;

    const partialHeadingMatch = headingParagraphs.find(({ paragraph }) => normalizeComparable(paragraph.replace(/^#{1,6}\s+/, '')).includes(normalizedQuery));
    if (partialHeadingMatch) return partialHeadingMatch.index;

    const paragraphMatch = paragraphs.findIndex((paragraph) => normalizeComparable(paragraph).includes(normalizedQuery));
    return paragraphMatch >= 0 ? paragraphMatch : 0;
}

function buildPaperReadResult(params: {
    doi: string;
    safeDoi: string;
    title: string;
    absolutePath: string;
    startParagraph: number;
    returnedParagraphs: number;
    sectionQuery?: string;
    truncated: boolean;
    contentText: string;
}): PaperReadResult {
    return {
        kind: "paper_read_result",
        doi: params.doi,
        safe_doi: params.safeDoi,
        title: params.title,
        canonical_uri: buildPaperUri(params.safeDoi),
        relative_path: toProjectRelative(params.absolutePath),
        absolute_path: params.absolutePath,
        start_paragraph: params.startParagraph,
        returned_paragraphs: params.returnedParagraphs,
        ...(params.sectionQuery ? { section_query: params.sectionQuery } : {}),
        truncated: params.truncated,
        citation_ready: true,
        content_text: params.contentText
    };
}

function buildPaperReadText(result: PaperReadResult): string {
    return [
        `# Paper Read Result`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Title** | ${result.title} |`,
        `| **DOI** | ${result.doi} |`,
        `| **File** | \`${result.relative_path}\` |`,
        `| **URI** | \`${result.canonical_uri}\` |`,
        `| **Paragraph Window** | start=${result.start_paragraph}, count=${result.returned_paragraphs} |`,
        result.section_query ? `| **Section Query** | ${result.section_query} |` : "",
        ``,
        result.content_text
    ].filter(Boolean).join('\n');
}

function buildPaperIndexEntry(fileName: string): PaperIndexEntry | null {
    const absolutePath = path.join(getPapersDirectory(), fileName);
    if (!fs.existsSync(absolutePath)) return null;

    const safeDoi = path.basename(fileName, '.md');
    const text = fs.readFileSync(absolutePath, 'utf-8');
    const metadata = parseFrontMatter(text);
    const stats = fs.statSync(absolutePath);

    return {
        doi: metadata.doi || "",
        safe_doi: safeDoi,
        title: metadata.title || "(unknown)",
        canonical_uri: buildPaperUri(safeDoi),
        relative_path: toProjectRelative(absolutePath),
        absolute_path: absolutePath,
        last_modified: stats.mtime.toISOString()
    };
}

function listSavedPaperIndex(): PaperIndexEntry[] {
    const papersDir = getPapersDirectory();
    if (!fs.existsSync(papersDir)) return [];

    return fs.readdirSync(papersDir)
        .filter((fileName) => fileName.endsWith('.md'))
        .sort()
        .map((fileName) => buildPaperIndexEntry(fileName))
        .filter((entry): entry is PaperIndexEntry => entry !== null);
}

// --- Fetch Strategies (Phase 1) ---
interface FetchResult {
    source: string;
    text?: string;       // If the API directly returns raw text/markdown
    pdfBuffer?: Buffer;  // If the API returns a PDF
}

async function fetchFromElsevier(doi: string): Promise<FetchResult | null> {
    const apiKey = getApiKey("ELSEVIER_API_KEY");
    if (!apiKey) return null;
    try {
        console.error(`Attempting Elsevier TDM API for DOI: ${doi}...`);
        // Try getting plain text first to skip PDF parsing
        const res = await axios.get(`https://api.elsevier.com/content/article/doi/${doi}`, {
            params: { httpAccept: "text/plain" },
            headers: { "X-ELS-APIKey": apiKey }
        });
        
        // text/plain returns a raw string; JSON returns a nested object
        const rawText = typeof res.data === 'string'
            ? res.data
            : res.data?.["full-text-retrieval-response"]?.originalText;
        if (rawText && typeof rawText === 'string' && rawText.length > 500) {
             return { source: "Elsevier TDM", text: rawText };
        }
    } catch(e: any) {
        console.error(`Elsevier TDM text/plain failed (${e.response?.status}). Checking permissions...`);
    }
    return null;
}

async function fetchFromSpringer(doi: string): Promise<FetchResult | null> {
    const apiKey = getApiKey("SPRINGER_OA_API_KEY");
    if (!apiKey) {
        console.error("Springer OA API skipped: SPRINGER_OA_API_KEY not configured.");
        return null;
    }
    try {
        console.error(`Attempting Springer OA API for DOI: ${doi}...`);
        // Springer OpenAccess API returns full text for OA articles
        const res = await axios.get(`https://api.springernature.com/openaccess/json`, {
            params: { q: `doi:${doi}`, api_key: apiKey }
        });
        const records = res.data?.records;
        if (records && records.length > 0) {
            const paragraphs = records[0].paragraphs;
            if (paragraphs && Array.isArray(paragraphs)) {
                // Combine paragraphs into markdown
                const text = paragraphs.map((p: any) => p.text).join("\n\n");
                return { source: "Springer OA API", text };
            }
        }
    } catch(e: any) {
        console.error(`Springer OA failed (${e.response?.status}).`);
    }
    return null;
}

// --- Fetch Strategies (Phase 2 & 3) ---

async function fetchFromOA(doi: string): Promise<FetchResult | null> {
    try {
        console.error(`Attempting Open Access (Unpaywall) for DOI: ${doi}...`);
        const etiquetteEmail = getEtiquetteEmail();
        const res = await axios.get(`https://api.unpaywall.org/v2/${doi}`, {
            params: { email: etiquetteEmail }
        });
        // Collect all OA locations with PDF URLs, prioritize repositories (arXiv, PMC) over publishers
        const locations = (res.data?.oa_locations || [])
            .filter((l: any) => l.url_for_pdf)
            .sort((a: any, b: any) => {
                if (a.host_type === 'repository' && b.host_type !== 'repository') return -1;
                if (a.host_type !== 'repository' && b.host_type === 'repository') return 1;
                return 0;
            });
        for (const loc of locations) {
            try {
                console.error(`OA: Trying ${loc.host_type} PDF: ${loc.url_for_pdf}`);
                const pdfRes = await axios.get(loc.url_for_pdf, { responseType: 'arraybuffer', timeout: 30000 });
                return { source: "Unpaywall OA", pdfBuffer: Buffer.from(pdfRes.data) };
            } catch (dlErr: any) {
                console.error(`OA: Failed (${dlErr.response?.status || dlErr.message}), trying next location...`);
            }
        }
        if (locations.length === 0) {
            console.error(`OA: No PDF URLs found for DOI: ${doi}`);
        }
    } catch(e: any) {
        console.error(`OA fetch failed (${e.response?.status || e.message}).`);
    }
    return null;
}

async function getWorkingSciHubMirror(configMirrorStore: string, fallback: string, autoUpdate: boolean): Promise<string> {
    const mirrorFile = path.resolve(PROJECT_ROOT, configMirrorStore);
    let mirrors = [fallback];
    
    try {
        if (fs.existsSync(mirrorFile)) {
             const content = fs.readFileSync(mirrorFile, 'utf-8');
             const lines = content.split('\n').map(l => l.trim()).filter(l => l.startsWith("http"));
             if (lines.length > 0) mirrors = lines;
        } else {
             fs.writeFileSync(mirrorFile, mirrors.join('\n'));
        }
    } catch(e) {
        console.error("Could not read SciHub mirror file, using fallback.", e);
    }
    
    // Test mirrors in order
    for (const mirror of mirrors) {
        try {
            await axios.get(mirror, { timeout: 3000 });
            
            // If the first working mirror wasn't the top of the list, and autoUpdate is true, promote it
            if (autoUpdate && mirrors[0] !== mirror) {
                console.error(`Auto-updating mirror file to prioritize working mirror: ${mirror}`);
                const newOrder = [mirror, ...mirrors.filter(m => m !== mirror)];
                fs.writeFileSync(mirrorFile, newOrder.join('\n'));
            }
            return mirror;
        } catch(e) {
            console.error(`Sci-Hub mirror ${mirror} is unreachable.`);
        }
    }
    
    console.error(`All configured Sci-Hub mirrors failed. Returning fallback.`);
    return fallback; 
}

async function fetchFromSciHub(doi: string, extractConfig: any): Promise<FetchResult | null> {
    try {
        const mirrorUrl = extractConfig?.sciHub?.fallbackMirror || "https://sci-hub.ru";
        const mirrorFile = extractConfig?.sciHub?.mirrorUrlFile || "./scihub-mirrors.txt";
        const autoUpdate = extractConfig?.sciHub?.autoUpdateMirror !== false;
        
        const activeMirror = await getWorkingSciHubMirror(mirrorFile, mirrorUrl, autoUpdate);
        console.error(`Attempting Sci-Hub via mirror: ${activeMirror} for DOI: ${doi}...`);
        
        const res = await axios.get(`${activeMirror}/${doi}`, {
            headers: {
                 "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
            }
        });
        
        // Scrape the PDF iframe link using cheerio
        const html = res.data;
        const $ = cheerio.load(html);
        
        let pdfUrl = '';
        const embedSrc = $('embed[type="application/pdf"]').attr('src');
        const iframeSrc = $('iframe').attr('src');
        const buttonOnclick = $('button').attr('onclick');

        if (embedSrc) {
            pdfUrl = embedSrc;
        } else if (iframeSrc) {
            pdfUrl = iframeSrc;
        } else if (buttonOnclick) {
            // E.g. onclick="location.href='//domain/path/file.pdf?download=true'"
            const match = buttonOnclick.match(/location\.href\s*=\s*['"](.*?)['"]/i);
            if (match && match[1]) {
                pdfUrl = match[1];
            }
        }
        
        if (pdfUrl) {
            if (pdfUrl.startsWith('//')) {
                pdfUrl = 'https:' + pdfUrl;
            } else if (pdfUrl.startsWith('/')) {
                pdfUrl = activeMirror + pdfUrl;
            }
            
            console.error(`Sci-Hub bypassed paywall! Downloading PDF from inner link: ${pdfUrl}`);
            const pdfRes = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
            return { source: "Sci-Hub", pdfBuffer: Buffer.from(pdfRes.data) };
        } else {
             console.error(`Sci-Hub fetched page but couldn't find a PDF embed or link.`);
        }
    } catch(e: any) {
        console.error(`Sci-Hub fetch failed (${e.message}).`);
    }
    return null;
}

function normalizeHeadlessBrowser(browserValue: string): string {
    const normalized = browserValue.toLowerCase().trim();
    if (normalized === "auto" || normalized.length === 0) return "msedge";
    if (normalized === "edge") return "msedge";
    if (normalized === "google-chrome" || normalized === "chromium" || normalized === "chromium-browser") return "chrome";
    return normalized;
}

function getHeadlessBrowserCandidates(browser: string): string[] {
    const homeDir = process.env.HOME || process.env.USERPROFILE || "";

    if (process.platform === "win32") {
        if (browser === "msedge") {
            return [
                "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
                "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe"
            ];
        }
        if (browser === "chrome") {
            return [
                "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
                "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
            ];
        }
        if (browser === "firefox") {
            return [
                "C:\\Program Files\\Mozilla Firefox\\firefox.exe",
                "C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe"
            ];
        }
    }

    if (process.platform === "darwin") {
        if (browser === "msedge") {
            return [
                "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
                path.join(homeDir, "Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge")
            ];
        }
        if (browser === "chrome") {
            return [
                "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
                path.join(homeDir, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
            ];
        }
        if (browser === "firefox") {
            return [
                "/Applications/Firefox.app/Contents/MacOS/firefox",
                path.join(homeDir, "Applications/Firefox.app/Contents/MacOS/firefox")
            ];
        }
    }

    if (process.platform === "linux") {
        if (browser === "msedge") {
            return [
                "/usr/bin/microsoft-edge",
                "/usr/bin/microsoft-edge-stable",
                "/snap/bin/microsoft-edge"
            ];
        }
        if (browser === "chrome") {
            return [
                "/usr/bin/google-chrome",
                "/usr/bin/google-chrome-stable",
                "/usr/bin/chromium",
                "/usr/bin/chromium-browser"
            ];
        }
        if (browser === "firefox") {
            return [
                "/usr/bin/firefox",
                "/snap/bin/firefox"
            ];
        }
    }

    return [];
}

function getHeadlessBrowserPathNames(browser: string): string[] {
    if (browser === "msedge") return ["msedge", "msedge.exe", "microsoft-edge", "microsoft-edge-stable"];
    if (browser === "chrome") return ["chrome", "chrome.exe", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
    if (browser === "firefox") return ["firefox", "firefox.exe"];
    return [];
}

function findExecutableOnPath(binaryNames: string[]): string | null {
    const pathEntries = (process.env.PATH || "")
        .split(path.delimiter)
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0);

    for (const directory of pathEntries) {
        for (const binaryName of binaryNames) {
            const candidate = path.join(directory, binaryName);
            if (fs.existsSync(candidate)) return candidate;

            if (process.platform === "win32" && !candidate.toLowerCase().endsWith(".exe")) {
                const exeCandidate = `${candidate}.exe`;
                if (fs.existsSync(exeCandidate)) return exeCandidate;
            }
        }
    }

    return null;
}

function resolveHeadlessBrowserExecutable(headlessConf: any): { browser: string; executablePath: string } | null {
    const configuredBrowser = normalizeHeadlessBrowser(String(headlessConf?.browser || "msedge"));
    const configuredExecutablePath = headlessConf?.executablePath ? String(headlessConf.executablePath) : "";

    if (configuredExecutablePath) {
        const resolvedExplicitPath = path.isAbsolute(configuredExecutablePath)
            ? configuredExecutablePath
            : path.resolve(PROJECT_ROOT, configuredExecutablePath);
        if (fs.existsSync(resolvedExplicitPath)) {
            return { browser: configuredBrowser, executablePath: resolvedExplicitPath };
        }
        console.error(`[Headless] Configured executablePath not found: ${resolvedExplicitPath}`);
    }

    const candidatePaths = getHeadlessBrowserCandidates(configuredBrowser);
    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return { browser: configuredBrowser, executablePath: candidatePath };
        }
    }

    const pathHit = findExecutableOnPath(getHeadlessBrowserPathNames(configuredBrowser));
    if (pathHit) {
        return { browser: configuredBrowser, executablePath: pathHit };
    }

    console.error(`[Headless] Could not resolve an executable for configured browser="${configuredBrowser}" on platform="${process.platform}".`);
    return null;
}

// --- Fetch Strategy (Phase 4: Headless Browser Fallback) ---
async function fetchFromHeadlessBrowser(doi: string, extractConfig: any): Promise<FetchResult | null> {
    const headlessConf = extractConfig?.headlessBrowser || {};
    const interactiveCaptchaHelp = headlessConf.interactiveCaptchaHelp !== false;
    const browserResolution = resolveHeadlessBrowserExecutable(headlessConf);

    if (!browserResolution) {
        return null;
    }

    const { browser: browserStr, executablePath } = browserResolution;
    const browserLabel = browserStr === "msedge"
        ? "Edge"
        : browserStr === "chrome"
            ? "Chrome"
            : browserStr === "firefox"
                ? "Firefox"
                : browserStr;

    try {
        console.error(`Launching ${browserLabel} Headless for DOI: ${doi}...`);
        let pdfBuffer: Buffer | null = null;
        
        const launchAndAttempt = async (isHeadless: boolean): Promise<boolean> => {
            // Fingerprint randomization: vary viewport to reduce detection
            const viewports = [
                { width: 1366, height: 768 },
                { width: 1440, height: 900 },
                { width: 1536, height: 864 },
                { width: 1920, height: 1080 }
            ];
            const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];
            const browser = await puppeteer.launch({
                executablePath,
                headless: isHeadless,
                defaultViewport: randomViewport,
                args: ['--disable-blink-features=AutomationControlled']
            });
            try {
                const page = await browser.newPage();
                let foundCaptcha = false;
                
                // 1. Setup Interceptor to catch any downloaded PDF
                page.on('response', async (response: any) => {
                    const contentType = response.headers()['content-type'];
                    if (contentType && contentType.includes('application/pdf')) {
                        try {
                            pdfBuffer = await response.buffer();
                            console.error(`   [${browserLabel}] Browser successfully intercepted PDF!`);
                        } catch(e){}
                    }
                });

                // 2. Try Publisher Page via DOI
                await page.goto(`https://doi.org/${doi}`, { waitUntil: 'networkidle2', timeout: 30000 }).catch(()=>{});
                
                const pageTitle = (await page.title()).toLowerCase();
                const pageHtml = await page.content();
                const isCloudflare = pageTitle.includes("just a moment") || pageTitle.includes("attention required") || pageHtml.includes('cf-browser');
                const isCaptcha = pageHtml.includes('captcha') || pageHtml.includes('recaptcha');
                
                if (isHeadless && (isCloudflare || isCaptcha)) {
                    console.error(`   [${browserLabel}] Anti-Bot / CAPTCHA detected in Headless mode!`);
                    await browser.close();
                    return true; // Return true to request retry in visible mode
                }

                // 3. Try to click generic "Download PDF" buttons on publisher page
                if (!pdfBuffer) {
                    const link = await page.$('a[href*="pdf"], a[title*="PDF"], a[class*="pdf"]').catch(()=>null);
                    if (link) {
                        console.error(`   [${browserLabel}] Clicking generic PDF link on publisher page...`);
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{}),
                            link.click().catch(()=>{})
                        ]);
                    }
                }
                
                // 4. Try SciHub inside the browser as a robust fallback
                if (!pdfBuffer) {
                    console.error(`   [${browserLabel}] Publisher PDF not found. Falling back to Browser Sci-Hub...`);
                    const mirrorFile = extractConfig?.sciHub?.mirrorUrlFile || "./scihub-mirrors.txt";
                    const activeMirror = await getWorkingSciHubMirror(mirrorFile, "https://sci-hub.ru", false);
                    await page.goto(`${activeMirror}/${doi}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
                    
                    const shHtml = await page.content();
                    if (isHeadless && (shHtml.includes('cf-browser') || shHtml.includes('captcha'))) {
                         console.error(`   [${browserLabel}] Sci-Hub is also protected by Cloudflare!`);
                         await browser.close();
                         return true; 
                    }
                    
                    const iframeSrc = await page.$eval('iframe, embed[type="application/pdf"]', (el: any) => el.src).catch(() => null);
                    if (iframeSrc) {
                         const pdfUrl = iframeSrc.startsWith('//') ? 'https:' + iframeSrc : (iframeSrc.startsWith('/') ? activeMirror + iframeSrc : iframeSrc);
                         // Navigate directly to the PDF URL to trigger response interception
                         await page.goto(pdfUrl, { waitUntil: 'domcontentloaded', timeout: 15000 }).catch(()=>{});
                    }
                }

                if (!isHeadless && !pdfBuffer) {
                    // Give user time to click the PDF themselves if we missed it
                    console.error(`   [${browserLabel}] Waiting 20 seconds for you to manually trigger the PDF download...`);
                    await new Promise(r => setTimeout(r, 20000));
                }

                await browser.close();
                return false; 
            } catch(e) {
                try { await browser.close(); } catch(err){}
                return false;
            }
        };
        
        let needsInteractive = await launchAndAttempt(true);
        
        if (needsInteractive && interactiveCaptchaHelp) {
            console.error("\n=======================================================");
            console.error(">>> CAPTCHA DETECTED! OPENING VISIBLE BROWSER WINDOW <<<");
            console.error(">>> PLEASE COMPLETE VERIFICATION IN THE POPUP WINDOW <<<");
            console.error(">>> IT WILL AUTOMATICALLY RESUME AFTER SOLVING...    <<<");
            console.error("=======================================================\n");
            await launchAndAttempt(false);
        }

        if (pdfBuffer) {
            return { source: `Headless Browser (${browserLabel})`, pdfBuffer };
        }
    } catch(e: any) {
        console.error(`Headless Browser Exception: ${e.message}`);
    }
    return null;
}

// --- Parsing Strategies (Phase 5) ---
async function parseWithLlamaParse(pdfBuffer: Buffer, fileName: string): Promise<string | null> {
    const apiKey = getApiKey("LLAMAPARSE_API_KEY");
    if (!apiKey) {
        console.error("LlamaParse skipped: LLAMAPARSE_API_KEY not configured.");
        return null;
    }

    try {
        console.error(`   [LlamaParse] Uploading ${fileName} for advanced parsing...`);
        const formData = new FormData();
        formData.append("file", pdfBuffer, { filename: fileName, contentType: "application/pdf" });

        const uploadRes = await axios.post("https://api.cloud.llamaindex.ai/api/parsing/upload", formData, {
            headers: {
                ...formData.getHeaders(),
                "Authorization": `Bearer ${apiKey}`,
                "Accept": "application/json"
            }
        });

        const jobId = uploadRes.data?.id;
        if (!jobId) throw new Error("No job ID returned from upload.");

        console.error(`   [LlamaParse] Job created (ID: ${jobId}). Polling for markdown result...`);
        
        // Poll for completion (up to 3 minutes: 36 * 5s)
        for (let i = 0; i < 36; i++) {
            await new Promise(r => setTimeout(r, 5000));
            const statusRes = await axios.get(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}`, {
                headers: { "Authorization": `Bearer ${apiKey}` }
            });
            const status = statusRes.data?.status;
            
            if (status === "SUCCESS") {
                console.error(`   [LlamaParse] Parsing SUCCESS! Downloading text...`);
                const mdRes = await axios.get(`https://api.cloud.llamaindex.ai/api/parsing/job/${jobId}/result/markdown`, {
                    headers: { "Authorization": `Bearer ${apiKey}` }
                });
                return mdRes.data?.markdown || null;
            } else if (status === "ERROR" || status === "FAILED") {
                throw new Error("LlamaParse job failed remotely.");
            }
        }
        throw new Error("LlamaParse parsing timed out after 3 minutes.");
    } catch(e: any) {
        console.error(`   [LlamaParse] Error:`, e.response?.data || e.message);
    }
    return null;
}

async function parseWithMarker(pdfBuffer: Buffer, fileName: string, timeoutMs: number = 120000): Promise<string | null> {
    try {
        const workerDir = path.resolve(PACKAGE_ROOT, "marker-worker");
        const pythonExec = resolveMarkerPython(workerDir);
        const workerPy = path.join(workerDir, "worker.py");
        if (!pythonExec || !fs.existsSync(workerPy)) {
            console.error(`   [Marker] Worker is not installed at ${workerDir}. Run the marker install script in marker-worker/.`);
            return null;
        }

        console.error(`   [Marker] Spawning local Marker worker for ${fileName}...`);

        const requestJson = JSON.stringify({
            fileName,
            pdfBase64: pdfBuffer.toString("base64"),
        });

        const responseJson = await new Promise<string>((resolve, reject) => {
            const child = spawn(pythonExec, [workerPy], {
                cwd: workerDir,
                stdio: ["pipe", "pipe", "pipe"],
                windowsHide: true,
            });

            let stdout = "";
            let stderr = "";
            let timedOut = false;

            const timer = setTimeout(() => {
                timedOut = true;
                child.kill();
                reject(new Error(`Marker timed out after ${timeoutMs}ms.`));
            }, timeoutMs);

            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");

            child.stdout.on("data", (chunk: string) => {
                stdout += chunk;
            });

            child.stderr.on("data", (chunk: string) => {
                stderr += chunk;
            });

            child.on("error", (error) => {
                clearTimeout(timer);
                reject(error);
            });

            child.on("close", (code) => {
                clearTimeout(timer);
                if (timedOut) return;
                if (code !== 0) {
                    reject(new Error(stderr || `Marker worker exited with code ${code}.`));
                    return;
                }
                resolve(stdout);
            });

            child.stdin.end(requestJson);
        });

        const response = JSON.parse(responseJson);
        if (!response?.ok) {
            throw new Error(response?.error || "Marker worker returned an unknown error.");
        }
        return response.markdown || null;
    } catch(e: any) {
        console.error(`   [Marker] Error:`, e.message);
    }
    return null;
}

async function parseWithNative(pdfBuffer: Buffer): Promise<string | null> {
    let parser: InstanceType<typeof PDFParse> | null = null;
    try {
        console.error(`   [Native] Parsing PDF with pdf-parse v2...`);
        parser = new PDFParse({ data: new Uint8Array(pdfBuffer) });
        const result = await parser.getText();
        return result.text || null;
    } catch(e: any) {
        console.error(`   [Native] Error:`, e.message);
    } finally {
        if (parser) await parser.destroy().catch(() => {});
    }
    return null;
}

// --- Zotero Web API Helper ---
interface ZoteroCreator {
    creatorType: string;
    firstName: string;
    lastName: string;
}

function parseAuthorName(fullName: string): ZoteroCreator {
    const parts = fullName.trim().split(/\s+/);
    if (parts.length === 1) {
        return { creatorType: "author", firstName: "", lastName: parts[0] };
    }
    const lastName = parts[parts.length - 1];
    const firstName = parts.slice(0, -1).join(" ");
    return { creatorType: "author", firstName, lastName };
}

async function saveToZotero(params: {
    doi: string;
    title: string;
    authors?: string[];
    abstract?: string;
    journal?: string;
    year?: string;
    url?: string;
    tags?: string[];
    collectionKey?: string;
}): Promise<{ success: boolean; itemKey?: string; error?: string }> {
    const apiKey = getApiKey("ZOTERO_API_KEY");
    const libraryId = config?.zotero?.libraryId || process.env.ZOTERO_LIBRARY_ID;
    const libraryType = config?.zotero?.libraryType || process.env.ZOTERO_LIBRARY_TYPE || "user";

    if (!apiKey) return { success: false, error: "ZOTERO_API_KEY is not configured in grados-config.json apiKeys." };
    if (!libraryId) return { success: false, error: "zotero.libraryId is not configured in grados-config.json." };

    const collectionKey = params.collectionKey || config?.zotero?.defaultCollectionKey || undefined;

    const creators: ZoteroCreator[] = (params.authors || []).map(parseAuthorName);

    const item: Record<string, any> = {
        itemType: "journalArticle",
        title: params.title,
        DOI: params.doi,
        creators,
    };
    if (params.abstract) item.abstractNote = params.abstract;
    if (params.journal)  item.publicationTitle = params.journal;
    if (params.year)     item.date = params.year;
    if (params.url)      item.url = params.url;
    if (params.tags && params.tags.length > 0) {
        item.tags = params.tags.map(t => ({ tag: t }));
    }
    if (collectionKey) item.collections = [collectionKey];

    try {
        const endpoint = `https://api.zotero.org/${libraryType}s/${libraryId}/items`;
        const res = await axios.post(endpoint, [item], {
            headers: {
                "Zotero-API-Key": apiKey,
                "Content-Type": "application/json",
            }
        });

        // Zotero returns 200 with a "successful" map; key is "0" for first item
        const successMap = res.data?.successful;
        const itemKey = successMap?.["0"]?.key;
        if (itemKey) {
            console.error(`✅ Zotero: saved "${params.title}" → item key ${itemKey}`);
            return { success: true, itemKey };
        }

        // Check for failures
        const failed = res.data?.failed?.["0"];
        if (failed) {
            return { success: false, error: `Zotero API error: ${failed.message || JSON.stringify(failed)}` };
        }

        return { success: false, error: `Unexpected Zotero response: ${JSON.stringify(res.data)}` };
    } catch (e: any) {
        const msg = e.response?.data ? JSON.stringify(e.response.data) : e.message;
        return { success: false, error: `Zotero API request failed: ${msg}` };
    }
}

// Tool Execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;

    if (name === "search_academic_papers") {
        const query = String(args?.query || "");
        const requestedLimit = Number(args?.limit ?? 15);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0 ? Math.floor(requestedLimit) : 15;
        const continuationToken = args?.continuation_token ? String(args.continuation_token) : undefined;

        // DEFAULT CONFIG IF NOT SET
        const searchOrder = config?.search?.order || ["Elsevier", "Springer", "WebOfScience", "PubMed", "Crossref"];
        const searchEnabled = config?.search?.enabled || {
             "Elsevier": true, "Springer": true, "WebOfScience": true, "Crossref": true, "PubMed": true
        };
        const adapters = buildSearchAdapters();

        let searchResult;
        try {
            searchResult = await runResumableSearch({
                query,
                limit,
                continuationToken,
                searchOrder,
                searchEnabled,
                adapters
            });
        } catch (e: any) {
            return {
                isError: true,
                content: [{ type: "text", text: `Error: ${e.message}` }]
            };
        }

        const finalResults = searchResult.results;

        // Format as Markdown for the LLM
        let formattedString = `Found ${finalResults.length} new unique papers for query: "${query}"\n\n`;
        finalResults.forEach((p, index) => {
            formattedString += `### ${index + 1}. ${p.title}\n`;
            formattedString += `- **DOI:** ${p.doi}\n`;
            formattedString += `- **Publisher/Source:** ${p.publisher || p.source}\n`;
            if (p.authors && p.authors.length > 0) formattedString += `- **Authors:** ${p.authors.join(", ")}\n`;
            if (p.year) formattedString += `- **Year:** ${p.year}\n`;
            if (p.abstract) formattedString += `- **Abstract:** ${p.abstract}\n`;
            formattedString += `\n`;
        });

        if (finalResults.length === 0) {
             formattedString = `No new academic papers found for query: "${query}".`;
        }

        formattedString += `---\n`;
        formattedString += `- **Has More:** ${searchResult.hasMore ? "Yes" : "No"}\n`;
        if (searchResult.exhaustedSources.length > 0) {
            formattedString += `- **Exhausted Sources:** ${searchResult.exhaustedSources.join(", ")}\n`;
        }
        if (searchResult.hasMore) {
            formattedString += `- **Next Step:** Call \`search_academic_papers\` again with the same query and the returned \`next_continuation_token\` from structuredContent.\n`;
        }
        if (searchResult.warnings.length > 0) {
            formattedString += `- **Warnings:** ${searchResult.warnings.join(" | ")}\n`;
        }

        return {
            content: [
                {
                    type: "text",
                    text: formattedString
                }
            ],
            structuredContent: {
                query,
                limit,
                results: finalResults,
                has_more: searchResult.hasMore,
                exhausted_sources: searchResult.exhaustedSources,
                next_continuation_token: searchResult.nextContinuationToken,
                warnings: searchResult.warnings,
                continuation_applied: searchResult.continuationApplied
            }
        };
    } else if (name === "extract_paper_full_text") {
        const doi = String(args?.doi || "");
        const publisher = String(args?.publisher || "").toLowerCase();
        const expectedTitle = args?.expected_title ? String(args.expected_title) : undefined;
        
        const extractConfig = config?.extract || {};
        const tdmOrder: string[] = extractConfig?.tdm?.order || ["Elsevier", "Springer"];
        const tdmEnabled: { [key: string]: boolean } = extractConfig?.tdm?.enabled || { "Elsevier": true, "Springer": true };
        const fetchStratOrder: string[] = extractConfig?.fetchStrategy?.order || ["TDM", "OA", "SciHub", "Headless"];
        const fetchStratEnabled: { [key: string]: boolean } = extractConfig?.fetchStrategy?.enabled || { "TDM": true, "OA": true, "SciHub": true, "Headless": true };
        
        let finalExtractedText = "";
        let successfulSource = "";
        let savedMarkdownPath = "";
        
        // Define our waterfall strategies
        const fetchStrategies: Array<{ name: string, run: () => Promise<FetchResult | null> }> = [];

        // 1. TDM Layer
        if (fetchStratEnabled["TDM"]) {
            fetchStrategies.push({
                name: "TDM",
                run: async () => {
                    for (const tdmName of tdmOrder) {
                        if (tdmEnabled[tdmName] === false) continue;
                        let res: FetchResult | null = null;
                        if (tdmName === "Elsevier") res = await fetchFromElsevier(doi);
                        if (tdmName === "Springer") res = await fetchFromSpringer(doi);
                        
                        if (res) return res; // Return the first successful TDM fetch
                    }
                    return null;
                }
            });
        }

        // 2. Open Access Aggregators
        if (fetchStratEnabled["OA"]) {
            fetchStrategies.push({
                name: "OA Aggregators",
                run: async () => await fetchFromOA(doi)
            });
        }

        // 3. Sci-Hub
        if (fetchStratEnabled["SciHub"]) {
            fetchStrategies.push({
                name: "SciHub",
                run: async () => await fetchFromSciHub(doi, extractConfig)
            });
        }

        // 4. Headless Browser Scrape
        if (fetchStratEnabled["Headless"]) {
            fetchStrategies.push({
                name: "Headless Scraper",
                run: async () => await fetchFromHeadlessBrowser(doi, extractConfig)
            });
        }

        for (const strategy of fetchStrategies) {
            console.error(`=> Executing Fetch Strategy: [${strategy.name}]`);
            try {
                const fetchRes = await strategy.run();
                if (!fetchRes) continue;

                let parsedMarkdown = "";

                // Has the API already provided raw text natively?
                if (fetchRes.text && fetchRes.text.length > 0) {
                    console.error(`   [${strategy.name}] successfully procured native text! (Length: ${fetchRes.text.length})`);
                    parsedMarkdown = fetchRes.text;
                } 
                // Or do we have a PDF Buffer that needs Progressive Parsing?
                else if (fetchRes.pdfBuffer) {
                    // Validate that the buffer is actually a PDF (starts with %PDF magic bytes)
                    const header = fetchRes.pdfBuffer.subarray(0, 5).toString('ascii');
                    if (!header.startsWith('%PDF')) {
                        console.error(`   [${strategy.name}] Downloaded content is not a valid PDF (header: "${header.replace(/[^\x20-\x7E]/g, '?')}"). Skipping.`);
                        continue;
                    }
                    console.error(`   [${strategy.name}] procured PDF Buffer. Saving to disk...`);
                    
                    // PDF files are saved to downloadDirectory (archival only, not indexed by RAG)
                    const downloadDir = getDownloadsDirectory();
                    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
                    
                    const safeDoi = safeDoiFromDoi(doi);
                    const pdfFilePath = path.join(downloadDir, `${safeDoi}.pdf`);
                    fs.writeFileSync(pdfFilePath, fetchRes.pdfBuffer);
                    console.error(`   💾 PDF saved successfully to: ${pdfFilePath}`);

                    console.error(`   Executing Progressive Parsing...`);
                    const parseOrder: string[] = extractConfig?.parsing?.order || ["LlamaParse", "Marker", "Native"];
                    const parseEnabled: { [key: string]: boolean } = extractConfig?.parsing?.enabled || { "LlamaParse": true, "Marker": true, "Native": true };
                    
                    for (const parser of parseOrder) {
                        if (parseEnabled[parser] === false) continue;
                        
                        // LlamaParse
                        if (parser === "LlamaParse" && !parsedMarkdown) {
                            const md = await parseWithLlamaParse(fetchRes.pdfBuffer, `${safeDoi}.pdf`);
                            if (md) {
                                console.error("   ✨ LlamaParse successfully converted PDF to Markdown.");
                                parsedMarkdown = md;
                                break;
                            }
                        }
                        
                        // Marker
                        if (parser === "Marker" && !parsedMarkdown) {
                            const markerTimeout = extractConfig?.parsing?.markerTimeout || 120000;
                            const md = await parseWithMarker(fetchRes.pdfBuffer, `${safeDoi}.pdf`, markerTimeout);
                            if (md) {
                                console.error("   ✨ Marker successfully converted PDF to Markdown.");
                                parsedMarkdown = md;
                                break;
                            }
                        }

                        // Native
                        if (parser === "Native" && !parsedMarkdown) {
                            const md = await parseWithNative(fetchRes.pdfBuffer);
                            if (md) {
                                console.error("   ✨ Native fallback successfully converted PDF to text.");
                                parsedMarkdown = md;
                                break;
                            }
                        }
                    }
                    
                    if (!parsedMarkdown) {
                         throw new Error(`All configured Parsers failed to extract text from the downloaded PDF for DOI: ${doi}`);
                    }
                }

                // 3. Quality Assurance Validation (minCharacters is now the single source of truth)
                const qaMin = extractConfig?.qa?.minCharacters || 1500;
                if (isValidPaperContent(parsedMarkdown, doi, qaMin, expectedTitle)) {
                    finalExtractedText = parsedMarkdown;
                    successfulSource = fetchRes.source;
                    console.error(`✅ QA Validation Passed! Length: ${parsedMarkdown.length}`);

                    // 4. Save parsed Markdown to papersDirectory for mcp-local-rag indexing
                    //    Separate from downloadDirectory (PDF) to avoid duplicate RAG ingestion
                    try {
                        const papersDir = getPapersDirectory();
                        if (!fs.existsSync(papersDir)) fs.mkdirSync(papersDir, { recursive: true });
                        const safeDoi = safeDoiFromDoi(doi);
                        const mdFilePath = path.join(papersDir, `${safeDoi}.md`);
                        // Prepend YAML front-matter with metadata for RAG enrichment
                        const frontMatter = [
                            '---',
                            `doi: "${doi}"`,
                            expectedTitle ? `title: "${expectedTitle.replace(/"/g, '\\"')}"` : '',
                            `source: "${fetchRes.source}"`,
                            `fetched_at: "${new Date().toISOString()}"`,
                            '---',
                            ''
                        ].filter(Boolean).join('\n');
                        fs.writeFileSync(mdFilePath, frontMatter + parsedMarkdown, 'utf-8');
                        savedMarkdownPath = mdFilePath;
                        console.error(`📚 Saved Markdown for RAG indexing: ${mdFilePath}`);
                    } catch (saveErr: any) {
                        console.error(`❌ Failed to save Markdown: ${saveErr.message}`);
                        throw new Error(`Failed to save extracted markdown for DOI ${doi}: ${saveErr.message}`);
                    }

                    break; // Success! Exit the waterfall.
                } else {
                    console.error(`❌ QA Validation Failed for [${strategy.name}]. Discarding and trying next strategy.`);
                }
            } catch (e) {
                console.error(`   [${strategy.name}] failed throwing Error:`, e);
                continue;
            }
        }

        if (!finalExtractedText) {
             return {
                 content: [{ type: "text", text: `Error: Failed to extract valid full text for DOI: ${doi} after exhausting all configured waterfall methods. The paywall might be too strong or the network is blocked.` }],
                 isError: true
             };
        }

        if (!savedMarkdownPath) {
            return {
                content: [{ type: "text", text: `Error: Extracted text for DOI ${doi} but failed to persist it into the papers directory.` }],
                isError: true
            };
        }

        const summary = buildPaperSavedSummary({
            doi,
            title: expectedTitle,
            source: successfulSource,
            text: fs.readFileSync(savedMarkdownPath, 'utf-8'),
            absolutePath: savedMarkdownPath
        });

        return buildPaperSavedSummaryResult(summary);
    } else if (name === "parse_pdf_file") {
        const filePath = String(args?.file_path || "");
        const expectedTitle = args?.expected_title ? String(args.expected_title) : undefined;
        const doi = args?.doi ? String(args.doi) : undefined;

        if (!filePath) {
            return {
                content: [{ type: "text", text: "Error: parse_pdf_file requires 'file_path'." }],
                isError: true
            };
        }

        const resolvedPath = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);

        if (!fs.existsSync(resolvedPath)) {
            return {
                content: [{ type: "text", text: `Error: File not found: ${resolvedPath}` }],
                isError: true
            };
        }

        const pdfBuffer = fs.readFileSync(resolvedPath);

        // Validate PDF magic bytes
        const header = pdfBuffer.subarray(0, 5).toString('ascii');
        if (!header.startsWith('%PDF')) {
            return {
                content: [{ type: "text", text: `Error: File is not a valid PDF (header: "${header.replace(/[^\x20-\x7E]/g, '?')}")` }],
                isError: true
            };
        }

        const extractConfig = config?.extract || {};
        const parseOrder: string[] = extractConfig?.parsing?.order || ["LlamaParse", "Marker", "Native"];
        const parseEnabled: { [key: string]: boolean } = extractConfig?.parsing?.enabled || { "LlamaParse": true, "Marker": true, "Native": true };
        const fileName = path.basename(resolvedPath);

        console.error(`[parse_pdf_file] Parsing ${fileName} via configured waterfall...`);

        let parsedMarkdown = "";

        for (const parser of parseOrder) {
            if (parseEnabled[parser] === false) continue;

            if (parser === "LlamaParse" && !parsedMarkdown) {
                const md = await parseWithLlamaParse(pdfBuffer, fileName);
                if (md) { console.error("   ✨ LlamaParse success."); parsedMarkdown = md; break; }
            }
            if (parser === "Marker" && !parsedMarkdown) {
                const markerTimeout = extractConfig?.parsing?.markerTimeout || 120000;
                const md = await parseWithMarker(pdfBuffer, fileName, markerTimeout);
                if (md) { console.error("   ✨ Marker success."); parsedMarkdown = md; break; }
            }
            if (parser === "Native" && !parsedMarkdown) {
                const md = await parseWithNative(pdfBuffer);
                if (md) { console.error("   ✨ Native success."); parsedMarkdown = md; break; }
            }
        }

        if (!parsedMarkdown) {
            return {
                content: [{ type: "text", text: `Error: All configured parsers failed to extract text from: ${resolvedPath}` }],
                isError: true
            };
        }

        // QA validation
        const qaMin = extractConfig?.qa?.minCharacters || 1500;
        if (!isValidPaperContent(parsedMarkdown, doi || fileName, qaMin, expectedTitle)) {
            return {
                content: [{ type: "text", text: `Error: QA validation failed for ${fileName}. The extracted text may be too short, contain paywall content, or not match the expected title.` }],
                isError: true
            };
        }

        // Save to papers directory if DOI is provided
        let savedPath = "";
        if (doi) {
            try {
                const papersDir = getPapersDirectory();
                if (!fs.existsSync(papersDir)) fs.mkdirSync(papersDir, { recursive: true });
                const safeDoi = safeDoiFromDoi(doi);
                const mdFilePath = path.join(papersDir, `${safeDoi}.md`);
                const frontMatter = [
                    '---',
                    `doi: "${doi}"`,
                    expectedTitle ? `title: "${expectedTitle.replace(/"/g, '\\"')}"` : '',
                    `source: "Local PDF (parse_pdf_file)"`,
                    `fetched_at: "${new Date().toISOString()}"`,
                    '---',
                    ''
                ].filter(Boolean).join('\n');
                fs.writeFileSync(mdFilePath, frontMatter + parsedMarkdown, 'utf-8');
                savedPath = mdFilePath;
                console.error(`📚 Saved Markdown for RAG indexing: ${mdFilePath}`);
            } catch (saveErr: any) {
                return {
                    content: [{ type: "text", text: `Error: Parsed PDF content but failed to save markdown for DOI ${doi}: ${saveErr.message}` }],
                    isError: true
                };
            }
        }

        if (doi) {
            const summary = buildPaperSavedSummary({
                doi,
                title: expectedTitle,
                source: "Local PDF (parse_pdf_file)",
                text: fs.readFileSync(savedPath, 'utf-8'),
                absolutePath: savedPath
            });
            return buildPaperSavedSummaryResult(summary);
        }

        return {
            content: [{
                type: "text",
                text: `# Parsed PDF [Source: Local File]\n## File: ${fileName}\n\n${parsedMarkdown}`
            }]
        };

    } else if (name === "read_saved_paper") {
        const lookup = resolvePaperLookup(args);
        if ("error" in lookup) {
            return {
                content: [{ type: "text", text: `Error: ${lookup.error}` }],
                isError: true
            };
        }

        const paperRecord = readSavedPaperFileBySafeDoi(lookup.safeDoi);
        if (!paperRecord) {
            return {
                content: [{ type: "text", text: `Error: Saved paper not found for ${lookup.requestedBy} "${lookup.safeDoi}".` }],
                isError: true
            };
        }

        const requestedStart = Math.max(0, Number(args?.start_paragraph ?? 0));
        const maxParagraphs = Math.max(1, Number(args?.max_paragraphs ?? 20));
        const includeFrontMatter = args?.include_front_matter === true;
        const sectionQuery = args?.section_query ? String(args.section_query) : undefined;

        const paragraphs = splitIntoParagraphs(paperRecord.text, includeFrontMatter);
        const sectionStart = findParagraphWindowStart(paragraphs, sectionQuery);
        const startParagraph = sectionQuery ? sectionStart : Math.min(requestedStart, Math.max(0, paragraphs.length - 1));
        const paragraphWindow = paragraphs.slice(startParagraph, startParagraph + maxParagraphs);
        const contentText = paragraphWindow.join('\n\n');
        const paperTitle = paperRecord.metadata.title || "(unknown)";
        const paperDoi = paperRecord.metadata.doi || (args?.doi ? String(args.doi) : lookup.safeDoi);
        const readResult = buildPaperReadResult({
            doi: paperDoi,
            safeDoi: lookup.safeDoi,
            title: paperTitle,
            absolutePath: paperRecord.absolutePath,
            startParagraph,
            returnedParagraphs: paragraphWindow.length,
            sectionQuery,
            truncated: startParagraph + paragraphWindow.length < paragraphs.length,
            contentText
        });

        return {
            content: [
                {
                    type: "text",
                    text: buildPaperReadText(readResult)
                },
                buildReadResourceLink(readResult)
            ],
            structuredContent: readResult
        };

    } else if (name === "save_paper_to_zotero") {
        const doi     = String(args?.doi || "");
        const title   = String(args?.title || "");
        const authors = Array.isArray(args?.authors) ? args.authors.map(String) : [];
        const abstract = args?.abstract ? String(args.abstract) : undefined;
        const journal  = args?.journal  ? String(args.journal)  : undefined;
        const year     = args?.year     ? String(args.year)     : undefined;
        const url      = args?.url      ? String(args.url)      : undefined;
        const tags     = Array.isArray(args?.tags) ? args.tags.map(String) : undefined;
        const collectionKey = args?.collection_key ? String(args.collection_key) : undefined;

        if (!doi || !title) {
            return {
                content: [{ type: "text", text: "Error: save_paper_to_zotero requires 'doi' and 'title'." }],
                isError: true
            };
        }

        const result = await saveToZotero({ doi, title, authors, abstract, journal, year, url, tags, collectionKey });

        if (result.success) {
            return {
                content: [{ type: "text", text: `✅ Saved to Zotero: "${title}" (DOI: ${doi}) — item key: ${result.itemKey}` }],
                structuredContent: {
                    success: true,
                    doi,
                    title,
                    item_key: result.itemKey
                }
            };
        } else {
            return {
                content: [{ type: "text", text: `❌ Failed to save to Zotero: ${result.error}` }],
                structuredContent: {
                    success: false,
                    doi,
                    title,
                    error: result.error
                },
                isError: true
            };
        }
    }

    return {
        content: [{ type: "text", text: `Error: Unknown tool "${name}". Available tools: ${TOOL_REGISTRY.map((tool) => tool.name).join(", ")}.` }],
        isError: true
    };
});

// --- MCP Resources ---
// Phase 1: Static read-only resources for service discovery and status.
// These allow clients that support resources (Claude Code @-mentions, Codex resource wrappers)
// to discover GRaDOS capabilities even without tools/list.

server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [...STATIC_RESOURCE_DEFINITIONS]
    };
});

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    const uri = request.params.uri;

    if (uri === "grados://about") {
        const about = {
            name: "GRaDOS",
            fullName: "Graduate Research and Document Operating System",
            version: GRADOS_VERSION,
            description: "MCP server for academic paper search and full-text extraction",
            capabilities: [
                "Waterfall search across academic databases (Crossref, PubMed, Web of Science, Elsevier, Springer)",
                "Canonical saved-paper summaries with structured outputs and resource links",
                "Deep paper reading via read_saved_paper and grados://papers/{safe_doi}",
                "Full-text extraction via TDM APIs, Open Access, Sci-Hub, and headless browser",
                "Progressive PDF parsing (LlamaParse → Marker → Native)",
                "QA validation to reject paywalls and truncated content",
                "Automatic Markdown output with YAML front-matter and install-agnostic path resolution",
                "Zotero web library integration for citation management"
            ],
            tools: TOOL_REGISTRY.map((tool) => ({ name: tool.name, purpose: tool.purpose })),
            companionMcp: {
                name: "mcp-local-rag",
                tools: [
                    { name: "query_documents", purpose: "Semantic + keyword search over locally indexed papers" },
                    { name: "ingest_file", purpose: "Index a Markdown paper file into local RAG database" },
                    { name: "list_files", purpose: "List all indexed papers with status" },
                    { name: "delete_file", purpose: "Remove stale or unwanted entries from the local RAG index" },
                    { name: "status", purpose: "Inspect local RAG database health and configuration warnings" }
                ]
            },
            installModes: [
                "npm/manual MCP registration (Codex, Claude Code, other MCP clients)",
                "Claude Code plugin bundling the same stdio MCP server"
            ],
            paperResourceTemplate: PAPER_RESOURCE_TEMPLATE,
            configPath: CONFIG_PATH,
            projectRoot: PROJECT_ROOT
        };
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(about, null, 2) }]
        };
    }

    if (uri === "grados://status") {
        const papersDir = getPapersDirectory();
        const downloadDir = getDownloadsDirectory();

        const status = {
            online: true,
            configLoaded: Object.keys(config).length > 0,
            configPath: CONFIG_PATH,
            directories: {
                papersDirectory: { path: papersDir, exists: fs.existsSync(papersDir) },
                downloadDirectory: { path: downloadDir, exists: fs.existsSync(downloadDir) }
            },
            apiKeys: {
                ELSEVIER_API_KEY: !!getApiKey("ELSEVIER_API_KEY"),
                WOS_API_KEY: !!getApiKey("WOS_API_KEY"),
                SPRINGER_meta_API_KEY: !!getApiKey("SPRINGER_meta_API_KEY"),
                SPRINGER_OA_API_KEY: !!getApiKey("SPRINGER_OA_API_KEY"),
                LLAMAPARSE_API_KEY: !!getApiKey("LLAMAPARSE_API_KEY"),
                ZOTERO_API_KEY: !!getApiKey("ZOTERO_API_KEY")
            },
            zotero: {
                configured: !!(config?.zotero?.libraryId && getApiKey("ZOTERO_API_KEY")),
                libraryType: config?.zotero?.libraryType || "not set"
            },
            academicEtiquetteEmail: getEtiquetteEmail(),
            searchSources: config?.search?.order || ["Elsevier", "Springer", "WebOfScience", "Crossref", "PubMed"],
            fetchStrategy: config?.extract?.fetchStrategy?.order || ["TDM", "OA", "SciHub", "Headless"],
            parsingOrder: config?.extract?.parsing?.order || ["LlamaParse", "Marker", "Native"],
            paperResourceTemplate: PAPER_RESOURCE_TEMPLATE.uriTemplate
        };
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(status, null, 2) }]
        };
    }

    if (uri === "grados://tools") {
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(buildToolMirrorEntries(), null, 2) }]
        };
    }

    if (uri === "grados://papers/index") {
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(listSavedPaperIndex(), null, 2) }]
        };
    }

    const paperSafeDoi = parsePaperUri(uri);
    if (paperSafeDoi) {
        const paperRecord = readSavedPaperFileBySafeDoi(paperSafeDoi);
        if (!paperRecord) {
            return {
                contents: [{ uri, mimeType: "text/plain", text: `Saved paper not found for URI: ${uri}` }]
            };
        }
        return {
            contents: [{ uri, mimeType: "text/markdown", text: paperRecord.text }]
        };
    }

    return {
        contents: [{ uri, mimeType: "text/plain", text: `Unknown resource URI: ${uri}` }]
    };
});

// CRITICAL: Must implement resources/templates/list even if empty.
// Codex disconnects ALL MCP servers if this returns -32601 (Method not found). See: github.com/openai/codex/issues/14454
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [PAPER_RESOURCE_TEMPLATE] };
});

// Start Server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("GRaDOS MCP Node.js server running on stdio");
}

main().catch(console.error);
