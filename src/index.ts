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
import { chromium } from 'patchright';
import FormData from 'form-data';
import { PDFParse } from 'pdf-parse';
import { spawn, spawnSync } from 'node:child_process';
import * as os from 'node:os';
import {
    runResumableSearch,
    type PaperMetadata,
    type SearchSourceAdapter,
    type SearchSourceName,
    type SearchSourcePage,
    type SearchSourceState
} from "./resumable-search.js";
import {
    benchmarkLogLine,
    classifyPdfContent,
    detectBotChallenge,
    extractElsevierMetadataSignal,
    extractScienceDirectPdfCandidates,
    parseScienceDirectIntermediateRedirect,
    type FetchAttemptDiagnostic,
    type FetchOutcome
} from "./publisher-utils.js";

// --- Path Resolution ---
// PACKAGE_ROOT: where grados is installed (contains marker-worker/, grados-config.example.json, etc.)
// In dist/index.js, __dirname is <install>/dist, so the package root is one level up.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

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

function copyDirectoryRecursive(sourceDir: string, destinationDir: string, skipNames: Set<string>): void {
    fs.mkdirSync(destinationDir, { recursive: true });

    for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
        if (skipNames.has(entry.name)) continue;

        const sourcePath = path.join(sourceDir, entry.name);
        const destinationPath = path.join(destinationDir, entry.name);

        if (entry.isDirectory()) {
            copyDirectoryRecursive(sourcePath, destinationPath, skipNames);
        } else if (entry.isFile()) {
            fs.copyFileSync(sourcePath, destinationPath);
        }
    }
}

function resolveProjectPathFrom(projectRoot: string, configuredPath: unknown, fallbackRelativePath: string): string {
    if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
        return path.isAbsolute(configuredPath)
            ? configuredPath
            : path.resolve(projectRoot, configuredPath);
    }
    return path.join(projectRoot, fallbackRelativePath);
}

function readConfigJsonSafe(configPath: string): any {
    try {
        if (fs.existsSync(configPath)) {
            return JSON.parse(fs.readFileSync(configPath, "utf-8"));
        }
    } catch (error) {
        console.error(`[GRaDOS] Failed to read config at ${configPath}:`, error);
    }
    return {};
}

interface ManagedBrowserPaths {
    preferManagedBrowser: boolean;
    autoInstallManagedBrowser: boolean;
    usePersistentProfile: boolean;
    managedDataDirectory: string;
    managedBrowserDirectory: string;
    profileDirectory: string;
}

function resolveManagedChildPath(projectRoot: string, baseDirectory: string, configuredPath: unknown, fallbackRelativePath: string): string {
    if (typeof configuredPath === "string" && configuredPath.trim().length > 0) {
        return path.isAbsolute(configuredPath)
            ? configuredPath
            : path.resolve(projectRoot, configuredPath);
    }
    return path.join(baseDirectory, fallbackRelativePath);
}

function getManagedBrowserPaths(projectRoot: string, headlessConf: any): ManagedBrowserPaths {
    const managedDataDirectory = resolveProjectPathFrom(projectRoot, headlessConf?.managedDataDirectory, ".grados/browser");
    const managedBrowserDirectory = resolveManagedChildPath(projectRoot, managedDataDirectory, headlessConf?.managedBrowserDirectory, path.join("browsers", "playwright"));
    const profileDirectory = resolveManagedChildPath(projectRoot, managedDataDirectory, headlessConf?.profileDirectory, path.join("profiles", "chrome"));

    return {
        preferManagedBrowser: headlessConf?.preferManagedBrowser !== false,
        autoInstallManagedBrowser: headlessConf?.autoInstallManagedBrowser !== false,
        usePersistentProfile: headlessConf?.usePersistentProfile !== false,
        managedDataDirectory,
        managedBrowserDirectory,
        profileDirectory
    };
}

function getManagedChromiumExecutableSuffixes(): string[] {
    if (process.platform === "darwin") {
        return [
            path.join("chrome-mac-arm64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing"),
            path.join("chrome-mac-x64", "Google Chrome for Testing.app", "Contents", "MacOS", "Google Chrome for Testing")
        ];
    }

    if (process.platform === "win32") {
        return [path.join("chrome-win64", "chrome.exe")];
    }

    return [
        path.join("chrome-linux64", "chrome"),
        path.join("chrome-linux", "chrome")
    ];
}

function findManagedChromiumExecutable(managedBrowserDirectory: string): string | null {
    if (!fs.existsSync(managedBrowserDirectory)) return null;

    const revisions = fs.readdirSync(managedBrowserDirectory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith("chromium-"))
        .map((entry) => path.join(managedBrowserDirectory, entry.name))
        .sort((left, right) => right.localeCompare(left));

    const suffixes = getManagedChromiumExecutableSuffixes();
    for (const revisionDirectory of revisions) {
        for (const suffix of suffixes) {
            const candidate = path.join(revisionDirectory, suffix);
            if (fs.existsSync(candidate)) {
                return candidate;
            }
        }
    }

    return null;
}

function resolvePatchrightCliPath(): string | null {
    const candidatePaths = [
        path.join(PACKAGE_ROOT, "node_modules", "patchright", "cli.js"),
        path.join(PACKAGE_ROOT, "..", "patchright", "cli.js")
    ];

    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return candidatePath;
        }
    }

    return null;
}

function bootstrapManagedBrowser(projectRoot: string, headlessConf: any, reasonLabel: string): void {
    const managed = getManagedBrowserPaths(projectRoot, headlessConf);
    if (!managed.preferManagedBrowser || !managed.autoInstallManagedBrowser) return;

    ensureDirectory(managed.managedDataDirectory);
    fs.mkdirSync(managed.managedBrowserDirectory, { recursive: true });
    if (managed.usePersistentProfile) {
        fs.mkdirSync(managed.profileDirectory, { recursive: true });
    }

    const existingExecutable = findManagedChromiumExecutable(managed.managedBrowserDirectory);
    if (existingExecutable) {
        console.log(`[GRaDOS] Managed browser already available for ${reasonLabel}: ${existingExecutable}`);
    } else {
        const patchrightCliPath = resolvePatchrightCliPath();
        if (!patchrightCliPath) {
            console.warn("[GRaDOS] Could not locate Patchright CLI. Skipping managed browser bootstrap.");
        } else {
            console.log(`[GRaDOS] Bootstrapping a dedicated GRaDOS browser for ${reasonLabel}...`);
            console.log(`[GRaDOS] Browser cache: ${managed.managedBrowserDirectory}`);
            if (managed.usePersistentProfile) {
                console.log(`[GRaDOS] Browser profile: ${managed.profileDirectory}`);
            }

            const install = spawnSync(process.execPath, [patchrightCliPath, "install", "chromium", "--no-shell"], {
                cwd: projectRoot,
                env: {
                    ...process.env,
                    PLAYWRIGHT_BROWSERS_PATH: managed.managedBrowserDirectory
                },
                stdio: "inherit"
            });

            if (install.status !== 0) {
                console.warn("[GRaDOS] Managed browser bootstrap failed. GRaDOS will still fall back to any configured/system Chromium browser.");
            } else {
                const installedExecutable = findManagedChromiumExecutable(managed.managedBrowserDirectory);
                if (installedExecutable) {
                    console.log(`[GRaDOS] Managed browser ready: ${installedExecutable}`);
                } else {
                    console.warn("[GRaDOS] Browser install completed, but the managed executable could not be resolved yet.");
                }
            }
        }
    }
}

function handleCliFlags(): void {
    if (process.argv.includes("--version") || process.argv.includes("-v")) {
        console.log(GRADOS_VERSION);
        process.exit(0);
    }

    const resolvedConfigPath = resolveConfigPath();
    const projectRoot = path.dirname(resolvedConfigPath);
    const shouldPrepareBrowser = process.argv.includes("--prepare-browser");
    const shouldSkipBrowserBootstrap = process.argv.includes("--skip-browser-bootstrap");
    let handled = false;

    if (process.argv.includes("--init")) {
        const exampleSrc = path.join(PACKAGE_ROOT, "grados-config.example.json");
        const destPath = resolvedConfigPath;

        if (fs.existsSync(destPath)) {
            console.log("grados-config.json already exists in this directory. No changes made.");
        } else if (!fs.existsSync(exampleSrc)) {
            console.error("Could not find grados-config.example.json in the package. Please create grados-config.json manually.");
            process.exitCode = 1;
        } else {
            fs.mkdirSync(path.dirname(destPath), { recursive: true });
            fs.copyFileSync(exampleSrc, destPath);
            console.log(`Created grados-config.json at ${destPath}`);
            console.log("Edit this file to add your API keys and configure GRaDOS.");
        }
        handled = true;
    }

    if (process.argv.includes("--init-marker")) {
        const markerSourceDir = path.join(PACKAGE_ROOT, "marker-worker");
        const markerTargetDir = path.join(projectRoot, "marker-worker");
        const skipNames = new Set([".cache", ".tools", ".venv", "local.env"]);

        if (fs.existsSync(markerTargetDir)) {
            console.log(`marker-worker already exists at ${markerTargetDir}. No changes made.`);
        } else if (!fs.existsSync(markerSourceDir)) {
            console.error("Could not find marker-worker in the package. Please copy it manually from the GRaDOS distribution.");
            process.exitCode = 1;
        } else {
            copyDirectoryRecursive(markerSourceDir, markerTargetDir, skipNames);
            console.log(`Created marker-worker scaffold at ${markerTargetDir}`);
            console.log("Run the install script in that directory to provision Marker for this project.");
        }
        handled = true;
    }

    if ((process.argv.includes("--init") || shouldPrepareBrowser) && !shouldSkipBrowserBootstrap) {
        const effectiveConfig = readConfigJsonSafe(resolvedConfigPath);
        bootstrapManagedBrowser(projectRoot, effectiveConfig?.extract?.headlessBrowser || {}, process.argv.includes("--init") ? "--init" : "--prepare-browser");
        handled = true;
    }

    if (handled) {
        process.exit();
    }
}

handleCliFlags();

dotenv.config();

// Apply a stealthy global User-Agent to evade basic 403 Forbidden blocks
axios.defaults.headers.common['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

const CONFIG_PATH = resolveConfigPath();

// PROJECT_ROOT: directory containing the config file. All user-project relative paths
// (markdown/, downloads/, mirror store) resolve against this, NOT process.cwd().
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
const isDebugEnabled = () => config?.debug === true || config?.debug?.enabled === true;

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
    assets_count: number;
    figures_count: number;
    tables_count: number;
    assets_directory_relative_path?: string;
    assets_manifest_relative_path?: string;
    full_text_saved: true;
    read_required_for_citation: true;
    preview_not_citable: true;
}

type PaperAssetKind = "figure" | "table" | "graphical_abstract" | "supplementary_material" | "source_data";

interface PaperAssetHint {
    kind: PaperAssetKind;
    label: string;
    ref?: string;
    caption?: string;
    source_url?: string;
    mime_type?: string;
    note?: string;
}

interface PaperAssetRecord extends PaperAssetHint {
    status: "saved" | "metadata_only" | "download_failed";
    relative_path?: string;
    absolute_path?: string;
    file_size_bytes?: number;
}

interface PaperSaveResult {
    markdownPath: string;
    assetRecords: PaperAssetRecord[];
    assetsDirectoryPath?: string;
    assetsManifestPath?: string;
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

interface SavedPaperSearchHit {
    safe_doi: string;
    doi: string;
    title: string;
    canonical_uri: string;
    relative_path: string;
    score: number;
    match_count: number;
    top_snippet: string;
    matched_sections: string[];
}

interface SavedPaperSearchResult {
    kind: "saved_paper_search_result";
    query: string;
    retrieval_mode: "local_rag_cli" | "lexical_fallback";
    papers: SavedPaperSearchHit[];
    warnings: string[];
}

interface LocalRagCliQueryHit {
    filePath: string;
    chunkIndex: number;
    text: string;
    score: number;
    fileTitle?: string | null;
    source?: string;
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
        assets_count: { type: "number" },
        figures_count: { type: "number" },
        tables_count: { type: "number" },
        assets_directory_relative_path: { type: "string" },
        assets_manifest_relative_path: { type: "string" },
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
        "assets_count",
        "figures_count",
        "tables_count",
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

const SAVED_PAPER_SEARCH_INPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        query: {
            type: "string",
            description: "Natural-language query for the local saved-paper library. Chinese and English are both supported."
        },
        limit: {
            type: "number",
            description: "Maximum number of papers to return (default: 5, clamped to 8).",
            default: 5
        }
    },
    required: ["query"],
    additionalProperties: false
};

const SAVED_PAPER_SEARCH_OUTPUT_SCHEMA: JsonSchema = {
    type: "object",
    properties: {
        kind: { type: "string", const: "saved_paper_search_result" },
        query: { type: "string" },
        retrieval_mode: { type: "string", enum: ["local_rag_cli", "lexical_fallback"] },
        papers: {
            type: "array",
            items: {
                type: "object",
                properties: {
                    safe_doi: { type: "string" },
                    doi: { type: "string" },
                    title: { type: "string" },
                    canonical_uri: { type: "string" },
                    relative_path: { type: "string" },
                    score: { type: "number" },
                    match_count: { type: "number" },
                    top_snippet: { type: "string" },
                    matched_sections: { type: "array", items: { type: "string" } }
                },
                required: [
                    "safe_doi",
                    "doi",
                    "title",
                    "canonical_uri",
                    "relative_path",
                    "score",
                    "match_count",
                    "top_snippet",
                    "matched_sections"
                ],
                additionalProperties: false
            }
        },
        warnings: {
            type: "array",
            items: { type: "string" }
        }
    },
    required: ["kind", "query", "retrieval_mode", "papers", "warnings"],
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
        name: "search_saved_papers",
        description: "Searches the local saved-paper library in the configured Markdown directory (default: markdown/). When a compatible mcp-local-rag index is available, GRaDOS uses that semantic+keyword retrieval path through the local CLI. Otherwise it falls back to a compact lexical search over saved Markdown papers. Returns paper-level hits (DOI, URI, snippet, matched sections) instead of raw chunks to keep context small.",
        purpose: "Search previously saved papers with a compact, paper-aware result format that is friendly to agent workflows",
        returns: "SavedPaperSearchResult with retrieval mode, compact paper hits, snippets, and warnings.",
        commonFailures: ["No saved papers exist yet", "Companion local-rag index is missing or incompatible, causing lexical fallback", "Malformed local-rag CLI output"],
        inputSchema: SAVED_PAPER_SEARCH_INPUT_SCHEMA,
        outputSchema: SAVED_PAPER_SEARCH_OUTPUT_SCHEMA
    },
    {
        name: "extract_paper_full_text",
        description: "Given a DOI, attempts to fetch the full text of the paper using a waterfall strategy. Saves full text to the configured Markdown directory (default: markdown/{safe_doi}.md), captures available figures/tables into its sibling assets directory, and returns a compact, non-citable summary with canonical paths and URI. Use read_saved_paper or the paper resource to access the full text when needed. Includes QA validation to ensure it's not a paywall.",
        purpose: "Fetch full-text paper content by DOI, save it to disk, and return a canonical saved-paper summary",
        returns: "PaperSavedSummary with canonical path, URI, preview excerpt, and section headings.",
        commonFailures: ["Paywall blocks all strategies", "PDF parsing fails", "QA validation rejects truncated content", "Saved markdown file could not be written"],
        inputSchema: EXTRACT_INPUT_SCHEMA,
        outputSchema: PAPER_SAVED_SUMMARY_SCHEMA
    },
    {
        name: "parse_pdf_file",
        description: "Parses a local PDF file using the configured parsing waterfall (LlamaParse → Marker → Native). Use this when you have already downloaded a PDF (e.g., via Playwright MCP browser automation) and need GRaDOS to parse it. If a DOI is provided, the parsed Markdown is saved to the configured Markdown directory with YAML front-matter and returned as a canonical saved-paper summary.",
        purpose: "Parse a local PDF file and optionally save it into the canonical papers store",
        returns: "Full parsed text for ad-hoc PDFs, or PaperSavedSummary when DOI-backed saving is requested.",
        commonFailures: ["File not found", "Not a valid PDF", "All parsers fail", "QA validation rejects content", "Saved markdown file could not be written"],
        inputSchema: PARSE_PDF_INPUT_SCHEMA
    },
    {
        name: "read_saved_paper",
        description: "Reads a previously saved paper from the configured Markdown directory. This is the canonical deep-reading tool for synthesis and citation verification. It supports DOI, safe_doi, or grados://papers/{safe_doi} identifiers plus paragraph windows and section queries.",
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

function looksLikeDoi(value: string): boolean {
    const normalized = value.trim();
    return /^10\.\d{4,9}\/\S+$/i.test(normalized);
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
    const queryExpression = looksLikeDoi(params.query)
        ? `DO=(${params.query.trim()})`
        : `TS=(${params.query})`;

    try {
        const response = await axios.get("https://api.clarivate.com/apis/wos-starter/v1/documents", {
            params: { q: queryExpression, page, limit: pageSize },
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
    const springerQuery = looksLikeDoi(params.query)
        ? `doi:${params.query.trim()}`
        : `keyword:"${params.query.replace(/"/g, '')}"`;
    try {
        const response = await axios.get("https://api.springernature.com/meta/v2/json", {
            params: { q: springerQuery, p: pageSize, api_key: apiKey }
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
            const $ = cheerio.load(xml, { xml: true });
            $('PubmedArticle').each((_, el) => {
                const pmid = $(el).find('PMID').first().text().trim();
                const abstractEl = $(el).find('Abstract');
                if (!pmid || abstractEl.length === 0) return;

                const rawAbstract = abstractEl.text().replace(/\s+/g, " ").trim();
                if (rawAbstract.length > 0) {
                    abstractMap.set(pmid, rawAbstract);
                }
            });
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
    return papersDirectory ? path.resolve(PROJECT_ROOT, papersDirectory) : path.join(PROJECT_ROOT, "markdown");
}

function getDownloadsDirectory(): string {
    const downloadDirectory = config?.extract?.downloadDirectory;
    return downloadDirectory ? path.resolve(PROJECT_ROOT, downloadDirectory) : path.join(PROJECT_ROOT, "downloads");
}

function resolveMarkerWorkerDirectory(): string {
    const configuredWorkerDir = config?.extract?.parsing?.markerWorkerDirectory;
    if (typeof configuredWorkerDir === "string" && configuredWorkerDir.trim().length > 0) {
        return path.isAbsolute(configuredWorkerDir)
            ? configuredWorkerDir
            : path.resolve(PROJECT_ROOT, configuredWorkerDir);
    }

    const projectWorkerDir = path.join(PROJECT_ROOT, "marker-worker");
    if (fs.existsSync(path.join(projectWorkerDir, "worker.py"))) {
        return projectWorkerDir;
    }

    return path.resolve(PACKAGE_ROOT, "marker-worker");
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

function ensureDirectory(dirPath: string): void {
    if (!fs.existsSync(dirPath)) {
        fs.mkdirSync(dirPath, { recursive: true });
    }
}

function escapeYamlDoubleQuoted(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function buildFrontMatter(fields: Record<string, string | number | boolean | undefined>): string {
    const lines = ['---'];
    for (const [key, rawValue] of Object.entries(fields)) {
        if (rawValue === undefined || rawValue === null || rawValue === "") continue;
        if (typeof rawValue === "string") {
            lines.push(`${key}: "${escapeYamlDoubleQuoted(rawValue)}"`);
        } else {
            lines.push(`${key}: ${String(rawValue)}`);
        }
    }
    lines.push('---', '');
    return lines.join('\n');
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
}

function getPaperAssetsDirectory(safeDoi: string): string {
    return path.join(getPapersDirectory(), "assets", safeDoi);
}

function getPaperAssetsManifestPath(safeDoi: string): string {
    return path.join(getPaperAssetsDirectory(safeDoi), "manifest.json");
}

function findAllOccurrences(text: string, needle: string): number[] {
    const matches: number[] = [];
    let cursor = 0;
    while (cursor >= 0 && cursor < text.length) {
        const hit = text.indexOf(needle, cursor);
        if (hit === -1) break;
        matches.push(hit);
        cursor = hit + needle.length;
    }
    return matches;
}

function detectElsevierBodyStart(rawText: string): number {
    const candidates = ["1 Introduction", "Introduction", "1 Background", "Background"];
    for (const marker of candidates) {
        const matches = findAllOccurrences(rawText, marker);
        if (matches.length >= 2) {
            return matches[1];
        }
        if (matches.length === 1 && matches[0] > 4000) {
            return matches[0];
        }
    }
    return 0;
}

function cleanElsevierBodyText(rawText: string): string {
    if (!rawText) return "";

    let working = rawText.replace(/\r/g, ' ').replace(/\n/g, ' ').replace(/\t/g, ' ').replace(/\u00a0/g, ' ');
    const bodyStart = detectElsevierBodyStart(working);
    if (bodyStart > 0) {
        working = working.slice(bodyStart);
    }

    working = working.replace(/ {2,}/g, ' ');
    working = working.replace(/\s+([,.;:!?])/g, '$1');
    return working.trim();
}

function trimCaptionSnippet(snippet: string, maxChars: number = 500): string {
    const normalized = normalizeWhitespace(snippet);
    if (normalized.length <= maxChars) return normalized;

    const truncated = normalized.slice(0, maxChars);
    const lastSentence = Math.max(
        truncated.lastIndexOf('. '),
        truncated.lastIndexOf('; '),
        truncated.lastIndexOf(': ')
    );
    if (lastSentence > 80) {
        return truncated.slice(0, lastSentence + 1).trim();
    }
    return `${truncated.trimEnd()}...`;
}

function extractCaptionMapFromText(rawText: string): Map<string, string> {
    const captionMap = new Map<string, string>();
    const normalized = normalizeWhitespace(cleanElsevierBodyText(rawText));
    if (!normalized) return captionMap;

    const matches = Array.from(normalized.matchAll(/\b(Fig(?:ure)?\.?|Figure|Table)\s*([0-9]+[A-Za-z]?)\b/g));
    for (let index = 0; index < matches.length; index++) {
        const match = matches[index];
        const prefix = match[1].toLowerCase().startsWith("table") ? "Table" : "Figure";
        const label = `${prefix} ${match[2]}`;
        if (captionMap.has(label)) continue;

        const start = match.index ?? 0;
        const nextStart = matches[index + 1]?.index ?? normalized.length;
        const windowEnd = Math.min(nextStart, start + 700);
        const snippet = normalized.slice(start, windowEnd);
        const caption = trimCaptionSnippet(snippet.replace(/^Fig\.?/i, "Figure"));
        if (caption.length > label.length + 8) {
            captionMap.set(label, caption);
        }
    }

    return captionMap;
}

function rankElsevierObjectType(objectType?: string): number {
    if (objectType === "IMAGE-HIGH-RES") return 5;
    if (objectType === "IMAGE-DOWNSAMPLED") return 4;
    if (objectType === "IMAGE-THUMBNAIL") return 3;
    if (objectType === "ALTIMG") return 2;
    if (objectType === "APPLICATION") return 1;
    return 0;
}

function classifyElsevierObjectRef(ref: string): { kind: PaperAssetKind; label: string } | null {
    const normalizedRef = ref.toLowerCase();
    const figureMatch = normalizedRef.match(/^gr(\d+)$/);
    if (figureMatch) {
        return { kind: "figure", label: `Figure ${figureMatch[1]}` };
    }

    const graphicalAbstractMatch = normalizedRef.match(/^ga(\d+)$/);
    if (graphicalAbstractMatch) {
        return { kind: "graphical_abstract", label: "Graphical Abstract" };
    }

    const tableMatch = normalizedRef.match(/^tb(?:l)?(\d+)$/);
    if (tableMatch) {
        return { kind: "table", label: `Table ${tableMatch[1]}` };
    }

    return null;
}

function selectPreferredElsevierAssets(objects: any[], captionMap: Map<string, string>): PaperAssetHint[] {
    const byRef = new Map<string, any>();

    for (const objectEntry of objects) {
        const ref = String(objectEntry?.["@ref"] || "").trim();
        const sourceUrl = typeof objectEntry?.["$"] === "string" ? objectEntry["$"] : "";
        const objectType = String(objectEntry?.["@type"] || "");
        if (!ref || !sourceUrl || objectType === "AAM-PDF") continue;

        const classification = classifyElsevierObjectRef(ref);
        if (!classification) continue;

        const current = byRef.get(ref);
        if (!current || rankElsevierObjectType(objectType) > rankElsevierObjectType(current["@type"])) {
            byRef.set(ref, objectEntry);
        }
    }

    const hints: PaperAssetHint[] = [];
    for (const [ref, objectEntry] of byRef.entries()) {
        const classification = classifyElsevierObjectRef(ref);
        if (!classification) continue;

        hints.push({
            kind: classification.kind,
            label: classification.label,
            ref,
            caption: captionMap.get(classification.label),
            source_url: typeof objectEntry?.["$"] === "string" ? objectEntry["$"] : undefined,
            mime_type: typeof objectEntry?.["@mimetype"] === "string" ? objectEntry["@mimetype"] : undefined
        });
    }

    return hints;
}

function extractElsevierAssetHintsFromText(rawText: string): PaperAssetHint[] {
    const captionMap = extractCaptionMapFromText(rawText);
    const normalized = normalizeWhitespace(rawText);
    const objectUrls = Array.from(new Set(normalized.match(/https:\/\/api\.elsevier\.com\/content\/object\/eid\/\S+/g) || []));
    const hints: PaperAssetHint[] = [];

    for (const objectUrl of objectUrls) {
        const refMatch = objectUrl.match(/-([A-Za-z]+\d+)\.(?:jpg|jpeg|png|gif|tif|tiff|sml)(?:\?|$)/i);
        const ref = refMatch?.[1];
        if (!ref) continue;

        const classification = classifyElsevierObjectRef(ref);
        if (!classification) continue;

        hints.push({
            kind: classification.kind,
            label: classification.label,
            ref,
            caption: captionMap.get(classification.label),
            source_url: objectUrl
        });
    }

    const tablesWithNoObjects = Array.from(captionMap.entries())
        .filter(([label]) => label.startsWith("Table "))
        .filter(([label]) => !hints.some((hint) => hint.label === label));

    for (const [label, caption] of tablesWithNoObjects) {
        hints.push({ kind: "table", label, caption, note: "Caption extracted from full text; no downloadable table object was exposed by the API." });
    }

    return hints;
}

function dedupeAssetHints(assetHints: PaperAssetHint[]): PaperAssetHint[] {
    const deduped = new Map<string, PaperAssetHint>();
    for (const hint of assetHints) {
        const key = [hint.kind, hint.label, hint.ref || "", hint.source_url || ""].join("|");
        if (!deduped.has(key)) deduped.set(key, hint);
    }
    return Array.from(deduped.values());
}

function guessFileExtension(asset: Pick<PaperAssetHint, "source_url" | "mime_type">): string {
    const mimeType = asset.mime_type?.toLowerCase();
    if (mimeType === "image/jpeg") return "jpg";
    if (mimeType === "image/png") return "png";
    if (mimeType === "image/gif") return "gif";
    if (mimeType === "application/pdf") return "pdf";
    if (mimeType === "text/csv") return "csv";
    if (mimeType === "application/vnd.ms-excel") return "xls";
    if (mimeType === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet") return "xlsx";
    if (mimeType === "video/mp4") return "mp4";

    if (asset.source_url) {
        try {
            const pathname = new URL(asset.source_url).pathname;
            const ext = path.extname(pathname).replace('.', '').toLowerCase();
            if (ext) return ext;
        } catch {
            // Ignore malformed URLs and fall through to the default.
        }
    }

    return "bin";
}

function normalizeAssetSlug(label: string): string {
    return label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || "asset";
}

async function persistPaperAssets(doi: string, safeDoi: string, assetHints: PaperAssetHint[]): Promise<{
    assetRecords: PaperAssetRecord[];
    assetsDirectoryPath?: string;
    assetsManifestPath?: string;
}> {
    if (assetHints.length === 0) {
        return { assetRecords: [] };
    }

    const assetsDirectoryPath = getPaperAssetsDirectory(safeDoi);
    ensureDirectory(assetsDirectoryPath);

    const assetRecords: PaperAssetRecord[] = [];
    let downloadIndex = 1;
    const elsevierApiKey = getApiKey("ELSEVIER_API_KEY");

    for (const assetHint of assetHints) {
        if (!assetHint.source_url) {
            assetRecords.push({
                ...assetHint,
                status: "metadata_only"
            });
            continue;
        }

        const extension = guessFileExtension(assetHint);
        const fileName = `${String(downloadIndex).padStart(2, '0')}_${normalizeAssetSlug(assetHint.label)}.${extension}`;
        const absolutePath = path.join(assetsDirectoryPath, fileName);
        const headers: Record<string, string> = {};
        if (assetHint.source_url.includes("api.elsevier.com") && elsevierApiKey) {
            headers["X-ELS-APIKey"] = elsevierApiKey;
        }

        try {
            const response = await axios.get(assetHint.source_url, {
                responseType: "arraybuffer",
                headers
            });
            const buffer = Buffer.from(response.data);
            fs.writeFileSync(absolutePath, buffer);
            assetRecords.push({
                ...assetHint,
                status: "saved",
                absolute_path: absolutePath,
                relative_path: toProjectRelative(absolutePath),
                file_size_bytes: buffer.length,
                mime_type: response.headers["content-type"] || assetHint.mime_type
            });
            downloadIndex += 1;
        } catch (error: any) {
            assetRecords.push({
                ...assetHint,
                status: "download_failed",
                note: assetHint.note || error.message
            });
        }
    }

    const assetsManifestPath = getPaperAssetsManifestPath(safeDoi);
    fs.writeFileSync(assetsManifestPath, JSON.stringify({
        doi,
        safe_doi: safeDoi,
        generated_at: new Date().toISOString(),
        assets: assetRecords
    }, null, 2));

    return {
        assetRecords,
        assetsDirectoryPath,
        assetsManifestPath
    };
}

function appendAssetSectionsToMarkdown(markdown: string, assetRecords: PaperAssetRecord[], markdownAbsolutePath?: string): string {
    if (assetRecords.length === 0) return markdown;

    const sections: string[] = [markdown.trimEnd()];
    const figureAssets = assetRecords.filter((asset) => asset.kind === "figure" || asset.kind === "graphical_abstract");
    const tableAssets = assetRecords.filter((asset) => asset.kind === "table");
    const supplementaryAssets = assetRecords.filter((asset) => asset.kind === "supplementary_material");
    const sourceDataAssets = assetRecords.filter((asset) => asset.kind === "source_data");

    const renderAssetGroup = (title: string, assets: PaperAssetRecord[]) => {
        if (assets.length === 0) return;
        sections.push('', `## ${title}`, '');

        for (const asset of assets) {
            sections.push(`### ${asset.label}`);
            if (asset.caption) sections.push('', asset.caption);
            if (asset.relative_path) {
                const renderedPath = markdownAbsolutePath && asset.absolute_path
                    ? path.relative(path.dirname(markdownAbsolutePath), asset.absolute_path).split(path.sep).join('/')
                    : asset.relative_path;
                sections.push('', `- Asset file: \`${renderedPath}\``);
            }
            if (asset.mime_type) sections.push(`- MIME type: \`${asset.mime_type}\``);
            if (asset.ref) sections.push(`- Source ref: \`${asset.ref}\``);
            if (asset.source_url) sections.push(`- Source URL: ${asset.source_url}`);
            sections.push(`- Capture status: \`${asset.status}\``);
            if (asset.note) sections.push(`- Note: ${asset.note}`);
            sections.push('');
        }
    };

    renderAssetGroup("Figures", figureAssets);
    renderAssetGroup("Tables", tableAssets);
    renderAssetGroup("Supplementary Materials", supplementaryAssets);
    renderAssetGroup("Source Data", sourceDataAssets);
    return sections.join('\n').trimEnd() + '\n';
}

async function savePaperMarkdown(params: {
    doi: string;
    title?: string;
    source: string;
    markdown: string;
    frontMatter?: Record<string, string | number | boolean | undefined>;
    assetHints?: PaperAssetHint[];
}): Promise<PaperSaveResult> {
    const papersDir = getPapersDirectory();
    ensureDirectory(papersDir);

    const safeDoi = safeDoiFromDoi(params.doi);
    const markdownPath = path.join(papersDir, `${safeDoi}.md`);
    const assetPersistence = await persistPaperAssets(params.doi, safeDoi, params.assetHints || []);
    const markdownWithAssets = appendAssetSectionsToMarkdown(params.markdown, assetPersistence.assetRecords, markdownPath);

    const frontMatter = buildFrontMatter({
        doi: params.doi,
        title: params.title,
        source: params.source,
        fetched_at: new Date().toISOString(),
        assets_count: assetPersistence.assetRecords.length,
        figures_count: assetPersistence.assetRecords.filter((asset) => asset.kind === "figure" || asset.kind === "graphical_abstract").length,
        tables_count: assetPersistence.assetRecords.filter((asset) => asset.kind === "table").length,
        assets_dir: assetPersistence.assetsDirectoryPath ? toProjectRelative(assetPersistence.assetsDirectoryPath) : undefined,
        assets_manifest: assetPersistence.assetsManifestPath ? toProjectRelative(assetPersistence.assetsManifestPath) : undefined,
        ...(params.frontMatter || {})
    });

    fs.writeFileSync(markdownPath, frontMatter + markdownWithAssets, 'utf-8');
    return {
        markdownPath,
        assetRecords: assetPersistence.assetRecords,
        assetsDirectoryPath: assetPersistence.assetsDirectoryPath,
        assetsManifestPath: assetPersistence.assetsManifestPath
    };
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
    return value.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
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
    assetRecords?: PaperAssetRecord[];
    assetsDirectoryPath?: string;
    assetsManifestPath?: string;
}): PaperSavedSummary {
    const safeDoi = safeDoiFromDoi(params.doi);
    const metadata = parseFrontMatter(params.text);
    const title = params.title || metadata.title || "(unknown)";
    const assetRecords = params.assetRecords || [];
    const figuresCount = assetRecords.filter((asset) => asset.kind === "figure" || asset.kind === "graphical_abstract").length;
    const tablesCount = assetRecords.filter((asset) => asset.kind === "table").length;

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
        assets_count: assetRecords.length,
        figures_count: figuresCount,
        tables_count: tablesCount,
        ...(params.assetsDirectoryPath ? { assets_directory_relative_path: toProjectRelative(params.assetsDirectoryPath) } : {}),
        ...(params.assetsManifestPath ? { assets_manifest_relative_path: toProjectRelative(params.assetsManifestPath) } : {}),
        full_text_saved: true,
        read_required_for_citation: true,
        preview_not_citable: true
    };
}

function buildPaperSavedSummaryText(summary: PaperSavedSummary): string {
    const headings = summary.section_headings.length > 0 ? summary.section_headings.join(" | ") : "(none detected)";
    const assetSummary = `${summary.assets_count} assets (${summary.figures_count} figures, ${summary.tables_count} tables)`;
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
        `| **Assets** | ${assetSummary} |`,
        summary.assets_manifest_relative_path ? `| **Asset Manifest** | \`${summary.assets_manifest_relative_path}\` |` : "",
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

function resolveProjectPath(configuredPath: unknown, fallbackRelativePath: string): string {
    return resolveProjectPathFrom(PROJECT_ROOT, configuredPath, fallbackRelativePath);
}

function getLocalRagDbPath(): string {
    return resolveProjectPath(config?.localRag?.dbPath, "lancedb");
}

function getLocalRagCacheDir(): string {
    return resolveProjectPath(config?.localRag?.cacheDir, "models");
}

function getLocalRagModelName(): string {
    const configured = config?.localRag?.modelName;
    return typeof configured === "string" && configured.trim().length > 0
        ? configured.trim()
        : "Xenova/all-MiniLM-L6-v2";
}

function getLocalRagCliCommand(): { command: string; args: string[] } {
    const command = typeof config?.localRag?.command === "string" && config.localRag.command.trim().length > 0
        ? config.localRag.command.trim()
        : "npx";
    const args = Array.isArray(config?.localRag?.args)
        ? config.localRag.args.map((value: unknown) => String(value))
        : ["-y", "mcp-local-rag"];

    return {
        command,
        args: args.length > 0 ? args : ["-y", "mcp-local-rag"]
    };
}

function directoryHasEntries(dirPath: string): boolean {
    return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
}

async function runCommandCapture(params: {
    command: string;
    args: string[];
    cwd: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
}): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; error?: Error }> {
    return await new Promise((resolve) => {
        let stdout = "";
        let stderr = "";
        let settled = false;
        let timedOut = false;
        let timeoutId: NodeJS.Timeout | undefined;

        const finalize = (result: { stdout: string; stderr: string; exitCode: number | null; timedOut: boolean; error?: Error }) => {
            if (settled) return;
            settled = true;
            if (timeoutId) clearTimeout(timeoutId);
            resolve(result);
        };

        const child = spawn(params.command, params.args, {
            cwd: params.cwd,
            env: params.env,
            stdio: ["ignore", "pipe", "pipe"]
        });

        child.stdout.on("data", (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk) => {
            stderr += chunk.toString();
        });

        child.on("error", (error) => {
            finalize({ stdout, stderr, exitCode: null, timedOut, error });
        });

        child.on("close", (code) => {
            finalize({ stdout, stderr, exitCode: code, timedOut });
        });

        timeoutId = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, params.timeoutMs ?? 180000);
    });
}

function compactWarningMessage(message: string, maxChars: number = 220): string {
    const normalized = message.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxChars) return normalized;
    return `${normalized.slice(0, maxChars - 3).trimEnd()}...`;
}

function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let index = 0;
    while (true) {
        const nextIndex = haystack.indexOf(needle, index);
        if (nextIndex === -1) break;
        count += 1;
        index = nextIndex + needle.length;
    }
    return count;
}

function extractSearchTokens(query: string): string[] {
    const normalized = normalizeComparable(query);
    if (!normalized) return [];

    return Array.from(new Set(
        normalized
            .split(/\s+/)
            .map((token) => token.trim())
            .filter((token) => token.length > 0)
            .filter((token) => token.length > 1 || /[^\x00-\x7F]/.test(token))
    ));
}

function scoreTextAgainstQuery(text: string, query: string, tokens: string[]): number {
    const normalizedText = normalizeComparable(text);
    if (!normalizedText) return 0;

    const normalizedQuery = normalizeComparable(query);
    let score = 0;

    if (normalizedQuery && normalizedText.includes(normalizedQuery)) {
        score += 6;
    }

    for (const token of tokens) {
        const occurrences = countOccurrences(normalizedText, token);
        if (occurrences > 0) {
            score += Math.min(occurrences, 3);
        }
    }

    return score;
}

function findNearestHeadingBeforeParagraph(paragraphs: string[], paragraphIndex: number): string | null {
    for (let index = Math.min(paragraphIndex, paragraphs.length - 1); index >= 0; index -= 1) {
        const match = paragraphs[index].match(/^#{1,6}\s+(.+)$/);
        if (match?.[1]) {
            return match[1].trim();
        }
    }
    return null;
}

function extractMatchingHeadings(text: string, query: string, maxHeadings: number = 3): string[] {
    const headings = extractSectionHeadings(text, 20);
    const normalizedQuery = normalizeComparable(query);
    const tokens = extractSearchTokens(query);

    const matches = headings.filter((heading) => {
        const normalizedHeading = normalizeComparable(heading);
        if (!normalizedHeading) return false;
        if (normalizedQuery && normalizedHeading.includes(normalizedQuery)) return true;
        return tokens.some((token) => normalizedHeading.includes(token));
    });

    return matches.slice(0, maxHeadings);
}

function extractBestParagraphMatch(text: string, query: string): {
    snippet: string;
    matchedSections: string[];
    matchCount: number;
    paragraphScore: number;
} {
    const paragraphs = splitIntoParagraphs(text, false);
    const tokens = extractSearchTokens(query);
    let bestParagraph = "";
    let bestScore = 0;
    let bestIndex = -1;
    let matchCount = 0;

    paragraphs.forEach((paragraph, index) => {
        const paragraphScore = scoreTextAgainstQuery(paragraph, query, tokens);
        if (paragraphScore > 0) {
            matchCount += 1;
        }
        if (paragraphScore > bestScore) {
            bestScore = paragraphScore;
            bestParagraph = paragraph;
            bestIndex = index;
        }
    });

    const matchedSections: string[] = [];
    if (bestIndex >= 0) {
        const nearestHeading = findNearestHeadingBeforeParagraph(paragraphs, bestIndex);
        if (nearestHeading) {
            matchedSections.push(nearestHeading);
        }
    }

    if (matchedSections.length === 0) {
        matchedSections.push(...extractMatchingHeadings(text, query, 3));
    }

    return {
        snippet: truncateText(bestParagraph || extractPreviewExcerpt(text, 260), 260),
        matchedSections: Array.from(new Set(matchedSections)).slice(0, 3),
        matchCount,
        paragraphScore: bestScore
    };
}

function resolveSavedPaperEntryFromPath(filePath: string): PaperIndexEntry | null {
    const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(PROJECT_ROOT, filePath);
    const papersDir = getPapersDirectory();
    const relativeToPapers = path.relative(papersDir, absolutePath);

    if (relativeToPapers.startsWith("..") || path.isAbsolute(relativeToPapers)) {
        return null;
    }

    if (path.extname(absolutePath).toLowerCase() !== ".md") {
        return null;
    }

    if (relativeToPapers.includes(path.sep)) {
        return null;
    }

    return buildPaperIndexEntry(path.basename(absolutePath));
}

function buildLexicalSavedPaperSearchResult(query: string, limit: number, warnings: string[] = []): SavedPaperSearchResult {
    const papers = listSavedPaperIndex()
        .map((entry) => {
            const text = fs.readFileSync(entry.absolute_path, "utf-8");
            const titleScore = scoreTextAgainstQuery(entry.title, query, extractSearchTokens(query)) * 4;
            const headingScore = extractMatchingHeadings(text, query, 5).length * 3;
            const paragraphMatch = extractBestParagraphMatch(text, query);
            const score = titleScore + headingScore + paragraphMatch.paragraphScore;

            if (score <= 0) {
                return null;
            }

            return {
                safe_doi: entry.safe_doi,
                doi: entry.doi,
                title: entry.title,
                canonical_uri: entry.canonical_uri,
                relative_path: entry.relative_path,
                score,
                match_count: paragraphMatch.matchCount,
                top_snippet: paragraphMatch.snippet,
                matched_sections: paragraphMatch.matchedSections
            } satisfies SavedPaperSearchHit;
        })
        .filter((entry): entry is SavedPaperSearchHit => entry !== null)
        .sort((left, right) => right.score - left.score)
        .slice(0, limit);

    return {
        kind: "saved_paper_search_result",
        query,
        retrieval_mode: "lexical_fallback",
        papers,
        warnings
    };
}

function buildSemanticSavedPaperSearchResult(query: string, hits: LocalRagCliQueryHit[], limit: number, warnings: string[] = []): SavedPaperSearchResult {
    const grouped = new Map<string, {
        entry: PaperIndexEntry;
        score: number;
        matchCount: number;
        snippet: string;
        matchedSections: string[];
    }>();

    for (const hit of hits) {
        const entry = resolveSavedPaperEntryFromPath(hit.filePath);
        if (!entry) continue;

        const current = grouped.get(entry.safe_doi);
        const paperRecord = readSavedPaperFileBySafeDoi(entry.safe_doi);
        const matchedSections = paperRecord ? extractMatchingHeadings(paperRecord.text, query, 3) : [];

        if (!current) {
            grouped.set(entry.safe_doi, {
                entry,
                score: hit.score,
                matchCount: 1,
                snippet: truncateText(hit.text.trim(), 260),
                matchedSections
            });
            continue;
        }

        current.matchCount += 1;
        current.score = Math.max(current.score, hit.score);
        if (hit.score >= current.score && hit.text.trim().length > 0) {
            current.snippet = truncateText(hit.text.trim(), 260);
        }
        current.matchedSections = Array.from(new Set([...current.matchedSections, ...matchedSections])).slice(0, 3);
    }

    const papers = Array.from(grouped.values())
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map((group) => ({
            safe_doi: group.entry.safe_doi,
            doi: group.entry.doi,
            title: group.entry.title,
            canonical_uri: group.entry.canonical_uri,
            relative_path: group.entry.relative_path,
            score: group.score,
            match_count: group.matchCount,
            top_snippet: group.snippet,
            matched_sections: group.matchedSections
        }));

    return {
        kind: "saved_paper_search_result",
        query,
        retrieval_mode: "local_rag_cli",
        papers,
        warnings
    };
}

function buildSavedPaperSearchText(result: SavedPaperSearchResult): string {
    const lines = [
        `# Saved Paper Search`,
        ``,
        `| Field | Value |`,
        `|-------|-------|`,
        `| **Query** | ${result.query} |`,
        `| **Retrieval Mode** | ${result.retrieval_mode} |`,
        `| **Results** | ${result.papers.length} |`,
        result.warnings.length > 0 ? `| **Warnings** | ${result.warnings.join(" | ")} |` : "",
        ``
    ].filter(Boolean);

    if (result.papers.length === 0) {
        lines.push(`No saved papers matched this query.`);
    } else {
        result.papers.forEach((paper, index) => {
            lines.push(
                `## ${index + 1}. ${paper.title}`,
                ``,
                `- DOI: ${paper.doi || "(unknown)"}`,
                `- URI: \`${paper.canonical_uri}\``,
                `- File: \`${paper.relative_path}\``,
                `- Score: ${paper.score.toFixed(3)}`,
                `- Match Count: ${paper.match_count}`,
                `- Matched Sections: ${paper.matched_sections.length > 0 ? paper.matched_sections.join(" | ") : "(none)"}`,
                ``,
                paper.top_snippet || "(empty snippet)",
                ``
            );
        });
        lines.push(`---`, `> Use \`read_saved_paper\` with the DOI, safe_doi, or URI above before synthesis or citation verification.`);
    }

    return lines.join('\n');
}

async function trySemanticSavedPaperSearch(query: string, limit: number): Promise<SavedPaperSearchResult | null> {
    if (config?.localRag?.enabled === false) {
        return null;
    }

    const dbPath = getLocalRagDbPath();
    if (!fs.existsSync(dbPath)) {
        return null;
    }

    const cacheDir = getLocalRagCacheDir();
    if (!directoryHasEntries(cacheDir)) {
        return buildLexicalSavedPaperSearchResult(query, limit, ["Local semantic cache was not found; returned lexical matches instead."]);
    }

    const { command, args } = getLocalRagCliCommand();
    const commandResult = await runCommandCapture({
        command,
        args: [
            ...args,
            "--db-path", dbPath,
            "--cache-dir", cacheDir,
            "--model-name", getLocalRagModelName(),
            "query",
            "--limit", String(limit),
            query
        ],
        cwd: PROJECT_ROOT,
        env: {
            ...process.env,
            BASE_DIR: getPapersDirectory(),
            DB_PATH: dbPath,
            CACHE_DIR: cacheDir,
            MODEL_NAME: getLocalRagModelName()
        },
        timeoutMs: 180000
    });

    if (commandResult.timedOut) {
        return buildLexicalSavedPaperSearchResult(query, limit, ["Local semantic search timed out; returned lexical matches instead."]);
    }

    if (commandResult.error) {
        return buildLexicalSavedPaperSearchResult(query, limit, [`Local semantic search failed to start (${compactWarningMessage(commandResult.error.message)}); returned lexical matches instead.`]);
    }

    if (commandResult.exitCode !== 0) {
        const reason = compactWarningMessage(commandResult.stderr || commandResult.stdout || `exit code ${commandResult.exitCode}`);
        return buildLexicalSavedPaperSearchResult(query, limit, [`Local semantic search failed (${reason}); returned lexical matches instead.`]);
    }

    try {
        const parsed = JSON.parse(commandResult.stdout) as LocalRagCliQueryHit[];
        const semanticResult = buildSemanticSavedPaperSearchResult(query, Array.isArray(parsed) ? parsed : [], limit);
        if (semanticResult.papers.length > 0) {
            return semanticResult;
        }
        return buildLexicalSavedPaperSearchResult(query, limit, ["Local semantic search returned no saved-paper hits; returned lexical matches instead."]);
    } catch (error: any) {
        return buildLexicalSavedPaperSearchResult(query, limit, [`Local semantic search returned unreadable JSON (${compactWarningMessage(error?.message || String(error))}); returned lexical matches instead.`]);
    }
}

async function searchSavedPapers(query: string, limit: number): Promise<SavedPaperSearchResult> {
    const semanticResult = await trySemanticSavedPaperSearch(query, limit);
    if (semanticResult) return semanticResult;
    return buildLexicalSavedPaperSearchResult(query, limit);
}

// --- Fetch Strategies (Phase 1) ---
interface FetchResult {
    source: string;
    text?: string;       // If the API directly returns raw text/markdown
    pdfBuffer?: Buffer;  // If the API returns a PDF
    metadata?: Record<string, string | number | boolean | undefined>;
    assetHints?: PaperAssetHint[];
    accessStatus?: string;
    outcome: FetchOutcome;
    diagnostic?: FetchAttemptDiagnostic;
}

function withTiming(startedAt: number): number {
    return Date.now() - startedAt;
}

function buildFetchDiagnostic(params: {
    strategy: string;
    source: string;
    outcome: FetchOutcome;
    startedAt: number;
    challengeSeen?: boolean;
    manualInterventionRequired?: boolean;
    finalUrl?: string;
    contentType?: string;
    pagesObserved?: number;
    failureReason?: string;
}): FetchAttemptDiagnostic {
    return {
        strategy: params.strategy,
        source: params.source,
        outcome: params.outcome,
        duration_ms: withTiming(params.startedAt),
        challenge_seen: params.challengeSeen,
        manual_intervention_required: params.manualInterventionRequired,
        final_url: params.finalUrl,
        content_type: params.contentType,
        pages_observed: params.pagesObserved,
        failure_reason: params.failureReason
    };
}

function isResultFullText(result: FetchResult | null): boolean {
    return Boolean(result?.text || result?.pdfBuffer);
}

function fallbackResultRank(result: FetchResult | null): number {
    if (!result) return 0;
    if (result.outcome === "metadata_only") return 3;
    if (result.outcome === "publisher_html_instead_of_pdf") return 2;
    if (result.outcome === "publisher_challenge" || result.outcome === "scihub_challenge") return 2;
    if (result.outcome === "timed_out") return 1;
    return 1;
}

function formatFetchDiagnosticsText(diagnostics: FetchAttemptDiagnostic[]): string {
    if (diagnostics.length === 0) return "";

    return diagnostics
        .map((diagnostic) => {
            const detailParts = [
                `${diagnostic.strategy}/${diagnostic.source}`,
                diagnostic.outcome,
                `${diagnostic.duration_ms}ms`
            ];
            if (diagnostic.failure_reason) detailParts.push(diagnostic.failure_reason);
            if (diagnostic.challenge_seen) detailParts.push("challenge");
            if (diagnostic.manual_intervention_required) detailParts.push("manual-help");
            return `- ${detailParts.join(" | ")}`;
        })
        .join('\n');
}

function buildElsevierMarkdown(params: {
    title?: string;
    abstract?: string;
    rawText?: string;
}): string {
    const sections: string[] = [];
    if (params.title) {
        sections.push(`# ${params.title}`, '');
    }
    if (params.abstract) {
        sections.push('## Abstract', '', normalizeWhitespace(params.abstract), '');
    }

    const bodyText = params.rawText ? cleanElsevierBodyText(params.rawText) : "";
    if (bodyText) {
        sections.push('## Full Text', '', bodyText, '');
    }

    return sections.join('\n').trim();
}

function extractElsevierAssetHints(articlePayload: any, rawText: string): PaperAssetHint[] {
    const captionMap = extractCaptionMapFromText(rawText);
    const objects = Array.isArray(articlePayload?.["full-text-retrieval-response"]?.objects?.object)
        ? articlePayload["full-text-retrieval-response"].objects.object
        : [];

    const structuredHints = selectPreferredElsevierAssets(objects, captionMap);
    const fallbackHints = structuredHints.length > 0 ? [] : extractElsevierAssetHintsFromText(rawText);
    const combined = dedupeAssetHints([...structuredHints, ...fallbackHints]);

    const existingLabels = new Set(combined.map((hint) => hint.label));
    for (const [label, caption] of captionMap.entries()) {
        if (!label.startsWith("Table ") || existingLabels.has(label)) continue;
        combined.push({
            kind: "table",
            label,
            caption,
            note: "Caption extracted from Elsevier full text; no downloadable table object was exposed by the API."
        });
    }

    return combined;
}

async function fetchFromElsevier(doi: string): Promise<FetchResult | null> {
    const apiKey = getApiKey("ELSEVIER_API_KEY");
    if (!apiKey) return null;
    const startedAt = Date.now();
    const strategy = "TDM";

    try {
        console.error(`Attempting Elsevier Article Retrieval API (view=FULL JSON) for DOI: ${doi}...`);
        const jsonRes = await axios.get(`https://api.elsevier.com/content/article/doi/${doi}`, {
            params: { view: "FULL" },
            headers: {
                "X-ELS-APIKey": apiKey,
                "Accept": "application/json"
            }
        });

        const retrieval = jsonRes.data?.["full-text-retrieval-response"] || {};
        const coredata = retrieval.coredata || {};
        const originalText = typeof retrieval.originalText === "string" ? retrieval.originalText : "";
        const title = coredata["dc:title"];
        const abstract = coredata["dc:description"];
        const markdown = buildElsevierMarkdown({ title, abstract, rawText: originalText });
        if (markdown.length > 1000) {
            return {
                source: "Elsevier Article Retrieval (view=FULL JSON)",
                outcome: "native_full_text",
                text: markdown,
                metadata: {
                    title,
                    pii: coredata.pii,
                    eid: coredata.eid,
                    doi: coredata["prism:doi"] || doi,
                    publisher: "Elsevier",
                    openaccess: coredata.openaccess,
                    extraction_status: jsonRes.headers["x-els-status"] || "OK"
                },
                assetHints: extractElsevierAssetHints(jsonRes.data, originalText),
                accessStatus: jsonRes.headers["x-els-status"] || "OK",
                diagnostic: buildFetchDiagnostic({
                    strategy,
                    source: "Elsevier Article Retrieval (view=FULL JSON)",
                    outcome: "native_full_text",
                    startedAt,
                    contentType: String(jsonRes.headers["content-type"] || "application/json")
                })
            };
        }
    } catch (e: any) {
        console.error(`Elsevier FULL JSON failed (${e.response?.status || e.message}). Trying text/plain fallback...`);
    }

    try {
        const textRes = await axios.get(`https://api.elsevier.com/content/article/doi/${doi}`, {
            params: { httpAccept: "text/plain" },
            headers: { "X-ELS-APIKey": apiKey }
        });
        const rawText = typeof textRes.data === 'string' ? textRes.data : "";
        const markdown = buildElsevierMarkdown({ rawText });
        if (markdown.length > 1000) {
            return {
                source: "Elsevier Article Retrieval (text/plain)",
                outcome: "native_full_text",
                text: markdown,
                metadata: {
                    doi,
                    publisher: "Elsevier",
                    extraction_status: textRes.headers["x-els-status"] || "OK"
                },
                assetHints: extractElsevierAssetHintsFromText(rawText),
                accessStatus: textRes.headers["x-els-status"] || "OK",
                diagnostic: buildFetchDiagnostic({
                    strategy,
                    source: "Elsevier Article Retrieval (text/plain)",
                    outcome: "native_full_text",
                    startedAt,
                    contentType: String(textRes.headers["content-type"] || "text/plain")
                })
            };
        }
    } catch (e: any) {
        console.error(`Elsevier text/plain failed (${e.response?.status || e.message}).`);
    }

    try {
        console.error(`Attempting Elsevier Article Retrieval API (metadata/no-view) for DOI: ${doi}...`);
        const metadataRes = await axios.get(`https://api.elsevier.com/content/article/doi/${doi}`, {
            headers: {
                "X-ELS-APIKey": apiKey,
                "Accept": "application/json"
            }
        });

        const signal = extractElsevierMetadataSignal(metadataRes.data, doi);
        if (signal) {
            return {
                source: "Elsevier Article Retrieval (metadata only)",
                outcome: "metadata_only",
                metadata: {
                    title: signal.title,
                    doi: signal.doi,
                    pii: signal.pii,
                    eid: signal.eid,
                    publisher: signal.publisher,
                    openaccess: signal.openaccess,
                    scidir: signal.scidir,
                    extraction_status: metadataRes.headers["x-els-status"] || "OK"
                },
                accessStatus: metadataRes.headers["x-els-status"] || "OK",
                diagnostic: buildFetchDiagnostic({
                    strategy,
                    source: "Elsevier Article Retrieval (metadata only)",
                    outcome: "metadata_only",
                    startedAt,
                    contentType: String(metadataRes.headers["content-type"] || "application/json"),
                    failureReason: "FULL and text/plain unavailable; retained metadata-only signal"
                })
            };
        }
    } catch (e: any) {
        console.error(`Elsevier metadata/no-view failed (${e.response?.status || e.message}).`);
    }

    return {
        source: "Elsevier Article Retrieval",
        outcome: "no_result",
        diagnostic: buildFetchDiagnostic({
            strategy,
            source: "Elsevier Article Retrieval",
            outcome: "no_result",
            startedAt,
            failureReason: "No usable full-text or metadata signal"
        })
    };
}

function normalizeSpringerAbstractContent(value: any): string {
    if (typeof value === "string") return normalizeWhitespace(value);
    if (value && typeof value === "object") {
        return normalizeWhitespace(Object.values(value).map((part) => String(part)).join(" "));
    }
    return "";
}

function buildSpringerArticleSegment(doi: string): string {
    return `art%3A${encodeURIComponent(doi)}`;
}

function buildSpringerStaticAssetUrl(doi: string, relativePath: string): string {
    return `https://static-content.springer.com/esm/${buildSpringerArticleSegment(doi)}/${relativePath.replace(/^\/+/, '')}`;
}

function buildSpringerImageAssetUrl(doi: string, relativePath: string, variant: string = "lw1200"): string {
    return `https://media.springernature.com/${variant}/springer-static/image/${buildSpringerArticleSegment(doi)}/${relativePath.replace(/^\/+/, '')}`;
}

function normalizeSpringerAssetUrl(rawUrl: string | undefined, baseUrl: string): string | undefined {
    if (!rawUrl || rawUrl.trim().length === 0) return undefined;
    if (rawUrl.startsWith("//")) return `https:${rawUrl}`;

    try {
        return new URL(rawUrl, baseUrl).toString();
    } catch {
        return undefined;
    }
}

function classifySpringerAssetKind(label: string, url?: string): PaperAssetKind {
    const normalizedLabel = label.toLowerCase();
    const normalizedUrl = url?.toLowerCase() || "";

    if (normalizedLabel.startsWith("source data") || normalizedUrl.endsWith(".xlsx") || normalizedUrl.endsWith(".csv")) {
        return "source_data";
    }
    if (normalizedLabel.includes("table")) return "table";
    if (normalizedLabel.includes("graphical abstract")) return "graphical_abstract";
    if (normalizedLabel.includes("supplementary") || normalizedLabel.includes("peer review file") || normalizedUrl.endsWith(".pdf") || normalizedUrl.endsWith(".mp4")) {
        return "supplementary_material";
    }
    return "figure";
}

function renderMarkdownTable(rows: string[][]): string {
    if (rows.length === 0) return "";

    const width = Math.max(...rows.map((row) => row.length));
    const normalizedRows = rows.map((row) => Array.from({ length: width }, (_, index) => row[index] || ""));
    const header = normalizedRows[0];
    const body = normalizedRows.slice(1);
    const separator = Array.from({ length: width }, () => "---");

    return [
        `| ${header.join(" | ")} |`,
        `| ${separator.join(" | ")} |`,
        ...body.map((row) => `| ${row.join(" | ")} |`)
    ].join('\n');
}

function extractTableRows($: cheerio.CheerioAPI, tableElement: any): string[][] {
    const rows: string[][] = [];
    $(tableElement).find('tr').each((_, row) => {
        const cells = $(row).find('th, td').toArray().map((cell) => normalizeWhitespace($(cell).text()));
        if (cells.some((cell) => cell.length > 0)) rows.push(cells);
    });
    return rows;
}

function renderSpringerJatsSection($: cheerio.CheerioAPI, sectionElement: any, level: number): string[] {
    const blocks: string[] = [];
    const heading = normalizeWhitespace($(sectionElement).children('title').first().text());
    if (heading) {
        blocks.push(`${'#'.repeat(Math.min(level, 6))} ${heading}`, '');
    }

    $(sectionElement).contents().each((_, node) => {
        if (node.type !== 'tag') return;

        const tagName = String((node as any).tagName || "").toLowerCase();
        if (tagName === 'title') return;

        if (tagName === 'p') {
            const paragraph = normalizeWhitespace($(node).text());
            if (paragraph) blocks.push(paragraph, '');
            return;
        }

        if (tagName === 'sec') {
            blocks.push(...renderSpringerJatsSection($, node, level + 1));
            return;
        }

        if (tagName === 'table-wrap') {
            const label = normalizeWhitespace($(node).children('label').first().text()) || "Table";
            const caption = normalizeWhitespace($(node).find('caption').first().text());
            const table = $(node).find('table').first();
            const tableRows = table.length > 0 ? extractTableRows($, table) : [];

            blocks.push(`### ${label}`, '');
            if (caption) blocks.push(caption, '');
            if (tableRows.length > 0) blocks.push(renderMarkdownTable(tableRows), '');
        }
    });

    return blocks;
}

function extractSpringerJatsAssetHints(xml: string, doi: string): PaperAssetHint[] {
    const $ = cheerio.load(xml, { xml: true });
    const hints: PaperAssetHint[] = [];

    $('article fig').each((index, fig) => {
        const label = normalizeWhitespace($(fig).children('label').first().text()) || `Figure ${index + 1}`;
        const caption = normalizeWhitespace($(fig).find('caption').first().text());
        const ref = $(fig).attr('id');
        const href = $(fig).find('graphic, media').first().attr('xlink:href') || $(fig).find('graphic, media').first().attr('href');

        hints.push({
            kind: classifySpringerAssetKind(label),
            label,
            caption,
            ref,
            source_url: href?.startsWith('MediaObjects/') ? buildSpringerImageAssetUrl(doi, href) : href
        });
    });

    $('article table-wrap').each((index, tableWrap) => {
        const label = normalizeWhitespace($(tableWrap).children('label').first().text()) || `Table ${index + 1}`;
        const caption = normalizeWhitespace($(tableWrap).find('caption').first().text());
        hints.push({
            kind: "table",
            label,
            caption,
            ref: $(tableWrap).attr('id'),
            note: "Structured table extracted from Springer JATS."
        });
    });

    $('article supplementary-material').each((index, item) => {
        const label = normalizeWhitespace($(item).find('label').first().text())
            || normalizeWhitespace($(item).attr('xlink:title') || "")
            || `Supplementary Material ${index + 1}`;
        const caption = normalizeWhitespace($(item).find('caption').first().text());
        const media = $(item).find('media').first();
        const href = media.attr('xlink:href') || media.attr('href');
        hints.push({
            kind: classifySpringerAssetKind(label, href),
            label,
            caption,
            ref: $(item).attr('id'),
            source_url: href?.startsWith('MediaObjects/') ? buildSpringerStaticAssetUrl(doi, href) : href,
            mime_type: media.attr('mimetype') && media.attr('mime-subtype')
                ? `${media.attr('mimetype')}/${media.attr('mime-subtype')}`
                : undefined
        });
    });

    return dedupeAssetHints(hints);
}

function extractSpringerJatsPayload(params: {
    xml: string;
    doi: string;
    fallbackTitle?: string;
    fallbackAbstract?: string;
}): { markdown: string; title?: string; abstract?: string; assetHints: PaperAssetHint[] } | null {
    const $ = cheerio.load(params.xml, { xml: true });
    const article = $('records > article').first();
    if (article.length === 0) return null;

    const title = normalizeWhitespace(article.find('front article-title').first().text()) || params.fallbackTitle;
    const abstract = normalizeWhitespace(article.find('front abstract').first().text()) || params.fallbackAbstract;
    const sections: string[] = [];

    if (title) sections.push(`# ${title}`, '');
    if (abstract) sections.push('## Abstract', '', abstract, '');

    const body = article.children('body').first();
    if (body.length > 0) {
        sections.push('## Full Text', '');
        const bodySections = body.children('sec').toArray();
        if (bodySections.length > 0) {
            for (const section of bodySections) {
                sections.push(...renderSpringerJatsSection($, section, 3));
            }
        } else {
            const bodyText = normalizeWhitespace(body.text());
            if (bodyText) sections.push(bodyText, '');
        }
    }

    const markdown = sections.join('\n').trim();
    if (markdown.length === 0) return null;

    return {
        markdown,
        title,
        abstract,
        assetHints: extractSpringerJatsAssetHints(params.xml, params.doi)
    };
}

function extractSpringerHtmlAssetHints(html: string, articleUrl: string): PaperAssetHint[] {
    const $ = cheerio.load(html);
    const hints: PaperAssetHint[] = [];

    $('.c-article-supplementary__item').each((_, item) => {
        const anchor = $(item).find('a[href]').first();
        const rawLabel = normalizeWhitespace(anchor.text().replace(/\s*\(download[^)]*\)\s*$/i, ''));
        const label = rawLabel || normalizeWhitespace($(item).attr('id') || "Supplementary Material");
        const href = normalizeSpringerAssetUrl(anchor.attr('href'), articleUrl);
        const imageHref = normalizeSpringerAssetUrl(anchor.attr('data-supp-info-image'), articleUrl);
        const caption = normalizeWhitespace($(item).find('.c-article-supplementary__description').first().text());
        const ref = $(item).attr('id');

        if (href) {
            hints.push({
                kind: classifySpringerAssetKind(label, href),
                label,
                caption,
                ref,
                source_url: href
            });
        }

        if (imageHref) {
            hints.push({
                kind: classifySpringerAssetKind(label, imageHref),
                label,
                caption,
                ref,
                source_url: imageHref
            });
        }
    });

    const mediaUrls = Array.from(new Set(html.match(/https:\/\/media\.springernature\.com\/[^"' \t\r\n<]+/g) || []));
    for (const mediaUrl of mediaUrls) {
        const figureMatch = mediaUrl.match(/_Fig(\d+)_/i);
        const label = figureMatch ? `Figure ${figureMatch[1]}` : path.basename(new URL(mediaUrl).pathname);
        hints.push({
            kind: classifySpringerAssetKind(label, mediaUrl),
            label,
            source_url: mediaUrl
        });
    }

    return dedupeAssetHints(hints);
}

function buildSpringerHtmlMarkdown(html: string, fallbackTitle?: string, fallbackAbstract?: string): string {
    const $ = cheerio.load(html);
    const title = normalizeWhitespace(
        $('meta[name="citation_title"]').attr('content')
        || $('h1.c-article-title').first().text()
        || $('title').first().text().replace(/\s+\|\s+Nature.*$/i, '')
        || fallbackTitle
        || ""
    );
    const abstract = normalizeWhitespace(
        $('section[data-title="Abstract"] .c-article-section__content').first().text()
        || $('meta[name="dc.description"]').attr('content')
        || fallbackAbstract
        || ""
    );

    const skippedSections = new Set([
        "Abstract",
        "Extended data figures and tables",
        "Supplementary information",
        "Source data",
        "Rights and permissions",
        "About this article"
    ]);

    const sections: string[] = [];
    if (title) sections.push(`# ${title}`, '');
    if (abstract) sections.push('## Abstract', '', abstract, '');

    $('section[data-title]').each((_, section) => {
        const sectionTitle = normalizeWhitespace($(section).attr('data-title') || "");
        if (!sectionTitle || skippedSections.has(sectionTitle)) return;

        const contentText = normalizeWhitespace($(section).find('.c-article-section__content').first().text());
        if (!contentText) return;

        sections.push(`## ${sectionTitle}`, '', contentText, '');
    });

    if (sections.length <= 4) {
        const bodyText = normalizeWhitespace($('.c-article-main-column').first().text());
        if (bodyText) sections.push('## Full Text', '', bodyText, '');
    }

    return sections.join('\n').trim();
}

function isSpringerHtmlContentLikelyUseful(html: string, expectedTitle?: string): boolean {
    const lowerHtml = html.toLowerCase();
    if (!lowerHtml.includes("c-article-section__title") && !lowerHtml.includes("c-article-main-column")) {
        return false;
    }

    if (expectedTitle) {
        const normalizedExpected = expectedTitle.toLowerCase().replace(/[^a-z0-9\s]/g, '').replace(/\s+/g, ' ').trim();
        const normalizedHtml = lowerHtml.replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ');
        if (!normalizedHtml.includes(normalizedExpected.substring(0, Math.min(50, normalizedExpected.length)))) {
            return false;
        }
    }

    return true;
}

async function fetchWithCookieRedirects(url: string, responseType: "text" | "arraybuffer" = "text"): Promise<{
    data: string | Buffer;
    headers: Record<string, any>;
    finalUrl: string;
}> {
    const cookies = new Map<string, string>();
    let currentUrl = url;

    for (let attempt = 0; attempt < 10; attempt += 1) {
        const headers: Record<string, string> = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36"
        };
        if (responseType === "arraybuffer") {
            headers["Accept"] = "application/pdf,application/octet-stream;q=0.9,*/*;q=0.8";
        } else {
            headers["Accept"] = "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8";
        }
        if (cookies.size > 0) {
            headers["Cookie"] = Array.from(cookies.values()).join("; ");
        }

        const response = await axios.get(currentUrl, {
            headers,
            responseType: responseType === "arraybuffer" ? "arraybuffer" : "text",
            validateStatus: () => true,
            maxRedirects: 0
        });

        const setCookies = response.headers["set-cookie"];
        if (Array.isArray(setCookies)) {
            for (const cookie of setCookies) {
                const cookiePair = cookie.split(';')[0];
                const separatorIndex = cookiePair.indexOf('=');
                if (separatorIndex <= 0) continue;
                const cookieName = cookiePair.substring(0, separatorIndex).trim();
                cookies.set(cookieName, cookiePair.trim());
            }
        }

        if (response.status >= 300 && response.status < 400 && response.headers.location) {
            currentUrl = new URL(String(response.headers.location), currentUrl).toString();
            continue;
        }

        if (response.status >= 200 && response.status < 300) {
            return {
                data: responseType === "arraybuffer" ? Buffer.from(response.data) : String(response.data),
                headers: response.headers,
                finalUrl: currentUrl
            };
        }

        throw new Error(`HTTP ${response.status} while fetching ${currentUrl}`);
    }

    throw new Error(`Too many redirects while fetching ${url}`);
}

async function fetchSpringerMetaRecord(doi: string): Promise<any | null> {
    const apiKey = getApiKey("SPRINGER_meta_API_KEY");
    if (!apiKey) return null;

    try {
        const response = await axios.get("https://api.springernature.com/meta/v2/json", {
            params: { q: `doi:${doi}`, p: 1, api_key: apiKey }
        });
        return response.data?.records?.[0] || null;
    } catch (error: any) {
        console.error(`Springer Meta DOI lookup failed (${error.response?.status || error.message}).`);
        return null;
    }
}

function pickSpringerRecordUrl(record: any, format: "html" | "pdf"): string | undefined {
    const urlEntry = Array.isArray(record?.url)
        ? record.url.find((entry: any) => entry?.format === format && typeof entry?.value === "string")
        : undefined;
    return urlEntry?.value;
}

async function fetchFromSpringer(doi: string): Promise<FetchResult | null> {
    const startedAt = Date.now();
    const strategy = "TDM";
    const metaRecord = await fetchSpringerMetaRecord(doi);
    const oaApiKey = getApiKey("SPRINGER_OA_API_KEY");
    const title = metaRecord?.title;
    const abstract = normalizeSpringerAbstractContent(metaRecord?.abstract);
    const publisherName = metaRecord?.publisher || metaRecord?.publisherName || "Springer Nature";
    const openaccessFlag = String(metaRecord?.openaccess ?? metaRecord?.openAccess ?? "").toLowerCase() === "true";
    const htmlUrl = pickSpringerRecordUrl(metaRecord, "html");
    const pdfUrl = pickSpringerRecordUrl(metaRecord, "pdf");

    let htmlMarkdown = "";
    let htmlAssetHints: PaperAssetHint[] = [];
    let htmlAccessStatus: string | undefined;

    if (oaApiKey && (openaccessFlag || !metaRecord)) {
        try {
            console.error(`Attempting Springer OA JATS for DOI: ${doi}...`);
            const jatsResponse = await axios.get("https://api.springernature.com/openaccess/jats", {
                params: { q: `doi:${doi}`, api_key: oaApiKey },
                responseType: "text"
            });

            const jatsPayload = extractSpringerJatsPayload({
                xml: String(jatsResponse.data),
                doi,
                fallbackTitle: title,
                fallbackAbstract: abstract
            });

            if (htmlUrl) {
                try {
                    const htmlResponse = await fetchWithCookieRedirects(htmlUrl, "text");
                    const rawHtml = String(htmlResponse.data);
                    if (isSpringerHtmlContentLikelyUseful(rawHtml, title)) {
                        htmlMarkdown = buildSpringerHtmlMarkdown(rawHtml, title, abstract);
                        htmlAssetHints = extractSpringerHtmlAssetHints(rawHtml, htmlResponse.finalUrl);
                        htmlAccessStatus = "direct_html_ok";
                    }
                } catch (htmlError: any) {
                    console.error(`Springer HTML asset pass after JATS failed (${htmlError.message}).`);
                }
            }

            if (jatsPayload && jatsPayload.markdown.length > 1000) {
                return {
                    source: "Springer OA JATS",
                    outcome: "native_full_text",
                    text: jatsPayload.markdown,
                    metadata: {
                        title: jatsPayload.title || title,
                        doi,
                        publisher: publisherName,
                        openaccess: metaRecord?.openaccess ?? metaRecord?.openAccess ?? "true",
                        extraction_status: "oa_jats_ok"
                    },
                    assetHints: dedupeAssetHints([...jatsPayload.assetHints, ...htmlAssetHints]),
                    accessStatus: htmlAccessStatus || "oa_jats_ok",
                    diagnostic: buildFetchDiagnostic({
                        strategy,
                        source: "Springer OA JATS",
                        outcome: "native_full_text",
                        startedAt
                    })
                };
            }
        } catch (error: any) {
            console.error(`Springer OA JATS failed (${error.response?.status || error.message}).`);
        }
    }

    if (htmlUrl) {
        try {
            console.error(`Attempting Springer/Nature HTML for DOI: ${doi}...`);
            const htmlResponse = await fetchWithCookieRedirects(htmlUrl, "text");
            const rawHtml = String(htmlResponse.data);
            if (isSpringerHtmlContentLikelyUseful(rawHtml, title)) {
                htmlMarkdown = buildSpringerHtmlMarkdown(rawHtml, title, abstract);
                htmlAssetHints = extractSpringerHtmlAssetHints(rawHtml, htmlResponse.finalUrl);
                htmlAccessStatus = "direct_html_ok";

                if (htmlMarkdown.length > 1000) {
                    return {
                        source: "Springer/Nature direct HTML",
                        outcome: "native_full_text",
                        text: htmlMarkdown,
                        metadata: {
                            title,
                            doi,
                            publisher: publisherName,
                            openaccess: metaRecord?.openaccess ?? metaRecord?.openAccess,
                            extraction_status: "direct_html_ok"
                        },
                        assetHints: htmlAssetHints,
                        accessStatus: "direct_html_ok",
                        diagnostic: buildFetchDiagnostic({
                            strategy,
                            source: "Springer/Nature direct HTML",
                            outcome: "native_full_text",
                            startedAt,
                            finalUrl: htmlResponse.finalUrl,
                            contentType: "text/html"
                        })
                    };
                }
            }
        } catch (error: any) {
            console.error(`Springer direct HTML failed (${error.message}).`);
        }
    }

    if (pdfUrl) {
        try {
            console.error(`Attempting Springer/Nature direct PDF for DOI: ${doi}...`);
            const pdfResponse = await fetchWithCookieRedirects(pdfUrl, "arraybuffer");
            const pdfBuffer = Buffer.isBuffer(pdfResponse.data) ? pdfResponse.data : Buffer.from(pdfResponse.data);
            if (pdfBuffer.length > 0) {
                return {
                    source: "Springer/Nature direct PDF",
                    outcome: "native_full_text",
                    pdfBuffer,
                    metadata: {
                        title,
                        doi,
                        publisher: publisherName,
                        openaccess: metaRecord?.openaccess ?? metaRecord?.openAccess,
                        extraction_status: "direct_pdf_ok"
                    },
                    assetHints: htmlAssetHints,
                    accessStatus: htmlAccessStatus || "direct_pdf_ok",
                    diagnostic: buildFetchDiagnostic({
                        strategy,
                        source: "Springer/Nature direct PDF",
                        outcome: "native_full_text",
                        startedAt,
                        finalUrl: pdfResponse.finalUrl,
                        contentType: String(pdfResponse.headers["content-type"] || "application/pdf")
                    })
                };
            }
        } catch (error: any) {
            console.error(`Springer direct PDF failed (${error.message}).`);
        }
    }

    return {
        source: "Springer/Nature",
        outcome: "no_result",
        diagnostic: buildFetchDiagnostic({
            strategy,
            source: "Springer/Nature",
            outcome: "no_result",
            startedAt,
            failureReason: "No usable HTML, JATS, or PDF result"
        })
    };
}

// --- Fetch Strategies (Phase 2 & 3) ---

async function fetchFromOA(doi: string): Promise<FetchResult | null> {
    const startedAt = Date.now();
    const strategy = "OA";
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
                const pdfBuffer = Buffer.from(pdfRes.data);
                const validation = classifyPdfContent(pdfBuffer, String(pdfRes.headers["content-type"] || ""));
                if (validation.isPdf) {
                    return {
                        source: "Unpaywall OA",
                        outcome: "native_full_text",
                        pdfBuffer,
                        diagnostic: buildFetchDiagnostic({
                            strategy,
                            source: "Unpaywall OA",
                            outcome: "native_full_text",
                            startedAt,
                            finalUrl: loc.url_for_pdf,
                            contentType: String(pdfRes.headers["content-type"] || "application/pdf")
                        })
                    };
                }
                console.error(`OA: Skipping non-PDF response (${validation.reason}) from ${loc.url_for_pdf}`);
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
    return {
        source: "Unpaywall OA",
        outcome: "no_result",
        diagnostic: buildFetchDiagnostic({
            strategy,
            source: "Unpaywall OA",
            outcome: "no_result",
            startedAt,
            failureReason: "No direct OA PDF location yielded a valid PDF"
        })
    };
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
    const startedAt = Date.now();
    const strategy = "SciHub";
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
        if (detectBotChallenge("", String(res.data), `${activeMirror}/${doi}`)) {
            return {
                source: "Sci-Hub",
                outcome: "scihub_challenge",
                diagnostic: buildFetchDiagnostic({
                    strategy,
                    source: "Sci-Hub",
                    outcome: "scihub_challenge",
                    startedAt,
                    challengeSeen: true,
                    finalUrl: `${activeMirror}/${doi}`,
                    failureReason: "Challenge page detected before PDF extraction"
                })
            };
        }
        
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
            const pdfBuffer = Buffer.from(pdfRes.data);
            const validation = classifyPdfContent(pdfBuffer, String(pdfRes.headers["content-type"] || ""));
            if (validation.isPdf) {
                return {
                    source: "Sci-Hub",
                    outcome: "native_full_text",
                    pdfBuffer,
                    diagnostic: buildFetchDiagnostic({
                        strategy,
                        source: "Sci-Hub",
                        outcome: "native_full_text",
                        startedAt,
                        finalUrl: pdfUrl,
                        contentType: String(pdfRes.headers["content-type"] || "application/pdf")
                    })
                };
            }
            return {
                source: "Sci-Hub",
                outcome: "scihub_no_pdf",
                diagnostic: buildFetchDiagnostic({
                    strategy,
                    source: "Sci-Hub",
                    outcome: "scihub_no_pdf",
                    startedAt,
                    finalUrl: pdfUrl,
                    contentType: String(pdfRes.headers["content-type"] || ""),
                    failureReason: validation.reason
                })
            };
        } else {
             console.error(`Sci-Hub fetched page but couldn't find a PDF embed or link.`);
        }
    } catch(e: any) {
        console.error(`Sci-Hub fetch failed (${e.message}).`);
    }
    return {
        source: "Sci-Hub",
        outcome: "scihub_no_pdf",
        diagnostic: buildFetchDiagnostic({
            strategy,
            source: "Sci-Hub",
            outcome: "scihub_no_pdf",
            startedAt,
            failureReason: "No Sci-Hub embed or valid PDF link found"
        })
    };
}

function normalizeHeadlessBrowser(browserValue: string): string {
    const normalized = browserValue.toLowerCase().trim();
    if (normalized === "auto" || normalized.length === 0) return "chrome";
    if (normalized === "edge") return "msedge";
    if (normalized === "google-chrome" || normalized === "chromium" || normalized === "chromium-browser") return "chrome";
    if (normalized === "firefox") {
        console.error("[Headless] Firefox is not supported by Patchright (Chromium-only). Falling back to chrome.");
        return "chrome";
    }
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
    }

    return [];
}

function getHeadlessBrowserPathNames(browser: string): string[] {
    if (browser === "msedge") return ["msedge", "msedge.exe", "microsoft-edge", "microsoft-edge-stable"];
    if (browser === "chrome") return ["chrome", "chrome.exe", "google-chrome", "google-chrome-stable", "chromium", "chromium-browser"];
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

interface ResolvedHeadlessBrowserExecutable {
    browser: string;
    executablePath: string;
    source: "managed" | "configured" | "system";
    profileDirectory?: string;
    managedBrowserDirectory?: string;
}

function resolveHeadlessBrowserExecutable(headlessConf: any): ResolvedHeadlessBrowserExecutable | null {
    const configuredBrowser = normalizeHeadlessBrowser(String(headlessConf?.browser || "chrome"));
    const configuredExecutablePath = headlessConf?.executablePath ? String(headlessConf.executablePath) : "";
    const managed = getManagedBrowserPaths(PROJECT_ROOT, headlessConf);
    const managedExecutable = managed.preferManagedBrowser
        ? findManagedChromiumExecutable(managed.managedBrowserDirectory)
        : null;

    if (managedExecutable) {
        return {
            browser: "chrome",
            executablePath: managedExecutable,
            source: "managed",
            profileDirectory: managed.usePersistentProfile ? managed.profileDirectory : undefined,
            managedBrowserDirectory: managed.managedBrowserDirectory
        };
    }

    if (configuredExecutablePath) {
        const resolvedExplicitPath = path.isAbsolute(configuredExecutablePath)
            ? configuredExecutablePath
            : path.resolve(PROJECT_ROOT, configuredExecutablePath);
        if (fs.existsSync(resolvedExplicitPath)) {
            return {
                browser: configuredBrowser,
                executablePath: resolvedExplicitPath,
                source: "configured",
                profileDirectory: configuredBrowser === "chrome" && managed.usePersistentProfile ? managed.profileDirectory : undefined,
                managedBrowserDirectory: configuredBrowser === "chrome" ? managed.managedBrowserDirectory : undefined
            };
        }
        console.error(`[Headless] Configured executablePath not found: ${resolvedExplicitPath}`);
    }

    const candidatePaths = getHeadlessBrowserCandidates(configuredBrowser);
    for (const candidatePath of candidatePaths) {
        if (fs.existsSync(candidatePath)) {
            return {
                browser: configuredBrowser,
                executablePath: candidatePath,
                source: "system",
                profileDirectory: configuredBrowser === "chrome" && managed.usePersistentProfile ? managed.profileDirectory : undefined,
                managedBrowserDirectory: configuredBrowser === "chrome" ? managed.managedBrowserDirectory : undefined
            };
        }
    }

    const pathHit = findExecutableOnPath(getHeadlessBrowserPathNames(configuredBrowser));
    if (pathHit) {
        return {
            browser: configuredBrowser,
            executablePath: pathHit,
            source: "system",
            profileDirectory: configuredBrowser === "chrome" && managed.usePersistentProfile ? managed.profileDirectory : undefined,
            managedBrowserDirectory: configuredBrowser === "chrome" ? managed.managedBrowserDirectory : undefined
        };
    }

    console.error(`[Headless] Could not resolve an executable for configured browser="${configuredBrowser}" on platform="${process.platform}".`);
    if (managed.preferManagedBrowser) {
        console.error(`[Headless] Expected managed browser directory: ${managed.managedBrowserDirectory}`);
        console.error(`[Headless] Run 'grados --prepare-browser' (or 'grados --init') to bootstrap the dedicated GRaDOS browser.`);
    }
    return null;
}

interface BrowserAutomationSession {
    browser: any;
    context: any;
    rootPage: any;
    transport: "pipe" | "cdp_port";
    cleanup: () => Promise<void>;
}

interface ReusableBrowserWindowState {
    session: BrowserAutomationSession;
    browser: string;
    browserLabel: string;
    executablePath: string;
    viewport: { width: number; height: number };
    createdAt: number;
    lastUsedAt: number;
}

let reusableBrowserWindow: ReusableBrowserWindowState | null = null;
let reusableBrowserWindowHooksBound = false;

function isReusableBrowserWindowAlive(): boolean {
    if (!reusableBrowserWindow) return false;

    const { session } = reusableBrowserWindow;
    if (!session?.context || !session?.rootPage) return false;
    if (session.browser && typeof session.browser.isConnected === "function" && !session.browser.isConnected()) return false;
    if (typeof session.rootPage.isClosed === "function" && session.rootPage.isClosed()) return false;
    return true;
}

async function destroyReusableBrowserWindow(): Promise<void> {
    if (!reusableBrowserWindow) return;

    const doomed = reusableBrowserWindow;
    reusableBrowserWindow = null;
    await doomed.session.cleanup().catch(() => {});
}

function bindReusableBrowserWindowCleanupHooks(): void {
    if (reusableBrowserWindowHooksBound) return;
    reusableBrowserWindowHooksBound = true;

    process.once("exit", () => {
        const doomed = reusableBrowserWindow;
        reusableBrowserWindow = null;
        if (!doomed) return;
        try {
            if (doomed.session.rootPage && !doomed.session.rootPage.isClosed?.()) {
                doomed.session.rootPage.close().catch(() => {});
            }
            doomed.session.context?.close?.().catch(() => {});
            doomed.session.browser?.close?.().catch(() => {});
        } catch {
            // Best effort only during process teardown.
        }
    });
}

async function ensureBrowserSessionRootPage(session: BrowserAutomationSession, viewport: { width: number; height: number }): Promise<any> {
    if (session.rootPage && !session.rootPage.isClosed?.()) {
        return session.rootPage;
    }

    session.rootPage = session.context.pages()[0] || await session.context.newPage();
    await session.rootPage.setViewportSize?.(viewport).catch(() => {});
    return session.rootPage;
}

async function closeSecondaryBrowserPages(context: any, rootPage: any): Promise<void> {
    const pages = context.pages?.() || [];
    for (const page of pages) {
        if (page === rootPage) continue;
        await page.close().catch(() => {});
    }
}

function isEdgePipeLaunchFailure(browser: string, error: unknown): boolean {
    if (process.platform !== "darwin" || browser !== "msedge") return false;
    const message = error instanceof Error ? error.message : String(error);
    return message.includes("Target page, context or browser has been closed")
        || message.includes("browserType.launch");
}

async function getFreeLocalPort(): Promise<number> {
    throw new Error("getFreeLocalPort is deprecated. Use DevToolsActivePort-based CDP discovery instead.");
}

async function waitForCdpEndpoint(port: number, child: any, timeoutMs = 15000): Promise<void> {
    const startedAt = Date.now();
    let lastError = "";

    while ((Date.now() - startedAt) < timeoutMs) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
            throw new Error(`Browser exited before CDP became ready${lastError ? ` (${lastError})` : ""}.`);
        }

        try {
            const response = await axios.get(`http://127.0.0.1:${port}/json/version`, {
                timeout: 1000,
                validateStatus: (status) => status >= 200 && status < 500
            });
            if (response.status === 200) return;
        } catch (e: any) {
            lastError = e?.message || String(e);
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for CDP endpoint on port ${port}${lastError ? ` (${lastError})` : ""}.`);
}

async function waitForDevToolsActivePort(userDataDir: string, child: any, timeoutMs = 15000): Promise<number> {
    const startedAt = Date.now();
    const devToolsFile = path.join(userDataDir, "DevToolsActivePort");
    let lastError = "";

    while ((Date.now() - startedAt) < timeoutMs) {
        if (child && (child.exitCode !== null || child.signalCode !== null)) {
            throw new Error(`Browser exited before DevToolsActivePort became ready${lastError ? ` (${lastError})` : ""}.`);
        }

        try {
            if (fs.existsSync(devToolsFile)) {
                const content = fs.readFileSync(devToolsFile, "utf-8").trim();
                const [firstLine] = content.split(/\r?\n/);
                const port = Number(firstLine);
                if (Number.isInteger(port) && port > 0) {
                    return port;
                }
            }
        } catch (e: any) {
            lastError = e?.message || String(e);
        }

        await new Promise((resolve) => setTimeout(resolve, 250));
    }

    throw new Error(`Timed out waiting for DevToolsActivePort${lastError ? ` (${lastError})` : ""}.`);
}

async function terminateChildProcess(child: any): Promise<void> {
    if (!child || child.exitCode !== null || child.signalCode !== null) return;

    await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => {
            if (settled) return;
            settled = true;
            resolve();
        };

        const forceKillTimer = setTimeout(() => {
            try { child.kill("SIGKILL"); } catch {}
            finish();
        }, 1500);

        child.once("exit", () => {
            clearTimeout(forceKillTimer);
            finish();
        });

        try {
            child.kill("SIGTERM");
        } catch {
            clearTimeout(forceKillTimer);
            finish();
        }
    });
}

async function launchChromiumSession(params: {
    browser: string;
    browserLabel: string;
    executablePath: string;
    isHeadless: boolean;
    viewport: { width: number; height: number };
    userDataDir?: string;
    launchArgs?: string[];
}): Promise<BrowserAutomationSession> {
    const launchArgs = [
        '--disable-blink-features=AutomationControlled',
        ...(params.launchArgs || [])
    ];

    if (params.userDataDir) {
        ensureDirectory(params.userDataDir);
        const context = await chromium.launchPersistentContext(params.userDataDir, {
            executablePath: params.executablePath,
            headless: params.isHeadless,
            args: launchArgs,
            viewport: params.viewport,
            acceptDownloads: true
        });
        const rootPage = context.pages()[0] || await context.newPage();
        await rootPage.setViewportSize?.(params.viewport).catch(() => {});
        return {
            browser: context.browser?.() || null,
            context,
            rootPage,
            transport: "pipe",
            cleanup: async () => {
                await context.close().catch(() => {});
            }
        };
    }

    try {
        const browser = await chromium.launch({
            executablePath: params.executablePath,
            headless: params.isHeadless,
            args: launchArgs
        });
        const context = await browser.newContext({
            viewport: params.viewport,
            acceptDownloads: true
        });
        const rootPage = await context.newPage();
        return {
            browser,
            context,
            rootPage,
            transport: "pipe",
            cleanup: async () => {
                await context.close().catch(() => {});
                await browser.close().catch(() => {});
            }
        };
    } catch (launchError) {
        if (!isEdgePipeLaunchFailure(params.browser, launchError)) {
            throw launchError;
        }

        console.error(`   [${params.browserLabel}] Playwright pipe launch failed on macOS. Retrying via CDP port fallback...`);

        const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "grados-edge-cdp-"));
        const appBundlePath = params.executablePath.includes(".app/Contents/MacOS/")
            ? params.executablePath.split("/Contents/MacOS/")[0]
            : "";
        const useOpenAppLauncher = process.platform === "darwin" && appBundlePath.length > 0;
        const browserStdoutPath = path.join(userDataDir, "browser-stdout.log");
        const browserStderrPath = path.join(userDataDir, "browser-stderr.log");
        const childArgs = [
            '--disable-blink-features=AutomationControlled',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-search-engine-choice-screen',
            '--disable-sync',
            '--disable-dev-shm-usage',
            '--password-store=basic',
            '--use-mock-keychain',
            '--no-sandbox',
            '--remote-debugging-port=0',
            `--user-data-dir=${userDataDir}`
        ];

        if (params.isHeadless) {
            childArgs.push('--headless=new');
        }

        childArgs.push('about:blank');

        const launcherCommand = useOpenAppLauncher ? "/usr/bin/open" : params.executablePath;
        const launcherArgs = useOpenAppLauncher
            ? [
                '-n',
                ...(params.isHeadless ? ['-g'] : []),
                appBundlePath,
                '--stdin',
                '/dev/null',
                '--stdout',
                browserStdoutPath,
                '--stderr',
                browserStderrPath,
                '--args',
                ...childArgs
            ]
            : childArgs;

        const child = spawn(launcherCommand, launcherArgs, {
            stdio: ['ignore', 'pipe', 'pipe']
        });

        let recentBrowserLogs = "";
        const appendLog = (chunk: Buffer | string) => {
            recentBrowserLogs = `${recentBrowserLogs}${String(chunk)}`;
            if (recentBrowserLogs.length > 4000) {
                recentBrowserLogs = recentBrowserLogs.slice(-4000);
            }
        };

        child.stdout?.on('data', appendLog);
        child.stderr?.on('data', appendLog);

        try {
            const launcherProbe = useOpenAppLauncher ? null : child;
            const port = await waitForDevToolsActivePort(userDataDir, launcherProbe);
            await waitForCdpEndpoint(port, launcherProbe);
            const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);

            let context: any = null;
            let ownsContext = false;
            try {
                context = await browser.newContext({
                    viewport: params.viewport,
                    acceptDownloads: true
                });
                ownsContext = true;
            } catch {
                context = browser.contexts()[0];
                if (!context) {
                    throw new Error("CDP fallback connected, but no browser context was available.");
                }
            }

            const rootPage = context.pages()[0] || await context.newPage();
            if (!ownsContext) {
                await rootPage.setViewportSize(params.viewport).catch(() => {});
            }

            return {
                browser,
                context,
                rootPage,
                transport: "cdp_port",
                cleanup: async () => {
                    if (ownsContext) {
                        await context.close().catch(() => {});
                    }
                    await browser.close().catch(() => {});
                    await terminateChildProcess(child);
                    fs.rmSync(userDataDir, { recursive: true, force: true });
                }
            };
        } catch (cdpError: any) {
            await terminateChildProcess(child);
            if (useOpenAppLauncher) {
                const fileLogs = [browserStdoutPath, browserStderrPath]
                    .filter((filePath) => fs.existsSync(filePath))
                    .map((filePath) => fs.readFileSync(filePath, "utf-8"))
                    .join("\n");
                if (fileLogs.trim()) {
                    recentBrowserLogs = `${recentBrowserLogs}\n${fileLogs}`.trim();
                    if (recentBrowserLogs.length > 4000) {
                        recentBrowserLogs = recentBrowserLogs.slice(-4000);
                    }
                }
            }
            fs.rmSync(userDataDir, { recursive: true, force: true });
            const detail = recentBrowserLogs.trim();
            const message = cdpError?.message || String(cdpError);
            throw new Error(detail ? `${message}\n${detail}` : message);
        }
    }
}

async function getOrCreateReusableBrowserWindow(params: {
    browser: string;
    browserLabel: string;
    executablePath: string;
    viewport: { width: number; height: number };
    userDataDir?: string;
}): Promise<BrowserAutomationSession> {
    if (isReusableBrowserWindowAlive()) {
        const activeWindow = reusableBrowserWindow!;
        activeWindow.lastUsedAt = Date.now();
        await ensureBrowserSessionRootPage(activeWindow.session, activeWindow.viewport);
        return activeWindow.session;
    }

    await destroyReusableBrowserWindow();

    const session = await launchChromiumSession({
        browser: params.browser,
        browserLabel: params.browserLabel,
        executablePath: params.executablePath,
        isHeadless: false,
        viewport: params.viewport,
        userDataDir: params.userDataDir,
        launchArgs: ['--new-window']
    });

    reusableBrowserWindow = {
        session,
        browser: params.browser,
        browserLabel: params.browserLabel,
        executablePath: params.executablePath,
        viewport: params.viewport,
        createdAt: Date.now(),
        lastUsedAt: Date.now()
    };
    bindReusableBrowserWindowCleanupHooks();
    return session;
}

// --- Fetch Strategy (Phase 4: Headless Browser Fallback) ---
async function fetchFromHeadlessBrowser(doi: string, extractConfig: any): Promise<FetchResult | null> {
    const startedAt = Date.now();
    const strategy = "Headless";
    const headlessConf = extractConfig?.headlessBrowser || {};
    const reuseInteractiveWindow = headlessConf.reuseInteractiveWindow !== false;
    const keepInteractiveWindowOpen = headlessConf.keepInteractiveWindowOpen !== false;
    const closePdfPageAfterCapture = headlessConf.closePdfPageAfterCapture !== false;
    const browserResolution = resolveHeadlessBrowserExecutable(headlessConf);

    if (!browserResolution) {
        return {
            source: "Headless Browser",
            outcome: "no_result",
            diagnostic: buildFetchDiagnostic({
                strategy,
                source: "Headless Browser",
                outcome: "no_result",
                startedAt,
                failureReason: "No compatible browser executable found"
            })
        };
    }

    const { browser: browserStr, executablePath, profileDirectory, source: browserSource } = browserResolution;
    const browserLabel = browserSource === "managed"
        ? "GRaDOS Chrome"
        : browserStr === "msedge"
            ? "Edge"
            : browserStr === "chrome"
                ? "Chrome"
                : browserStr;

    const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

    try {
        console.error(`Launching ${browserLabel} browser session for DOI: ${doi}...`);
        
        const launchAndAttempt = async (): Promise<FetchResult> => {
            // Fingerprint randomization: vary viewport to reduce detection
            const viewports = [
                { width: 1366, height: 768 },
                { width: 1440, height: 900 },
                { width: 1536, height: 864 },
                { width: 1920, height: 1080 }
            ];
            const randomViewport = viewports[Math.floor(Math.random() * viewports.length)];
            let session: BrowserAutomationSession | null = null;
            let retainWindow = false;
            try {
                retainWindow = reuseInteractiveWindow && keepInteractiveWindowOpen;
                session = retainWindow
                    ? await getOrCreateReusableBrowserWindow({
                        browser: browserStr,
                        browserLabel,
                        executablePath,
                        viewport: randomViewport,
                        userDataDir: profileDirectory
                    })
                    : await launchChromiumSession({
                        browser: browserStr,
                        browserLabel,
                        executablePath,
                        isHeadless: false,
                        viewport: randomViewport,
                        userDataDir: profileDirectory,
                        launchArgs: ['--new-window']
                    });

                const { context, transport } = session;
                const rootPage = await ensureBrowserSessionRootPage(session, randomViewport);
                if (transport === "cdp_port") {
                    console.error(`   [${browserLabel}] Using CDP-port fallback transport.`);
                }

                if (retainWindow) {
                    await closeSecondaryBrowserPages(context, rootPage);
                    await rootPage.bringToFront().catch(() => {});
                }

                const trackedPages = new Set<any>();
                const attemptedPdfUrls = new Set<string>();
                const pageListeners = new Map<any, {
                    popup: (popup: any) => void;
                    response: (response: any) => Promise<void>;
                    frameNavigated: (frame: any) => void;
                }>();
                const attemptedPageActions = new WeakMap<any, {
                    dropdownClicked?: boolean;
                    genericClicked?: boolean;
                    scienceDirectViewPdfClicked?: boolean;
                    scienceDirectPdfFlowDelegated?: boolean;
                    scienceDirectModalDismissed?: boolean;
                }>();
                let pdfBuffer: Buffer | null = null;
                let finalUrl = "";
                let finalContentType = "";
                let challengeSeen = false;
                let manualInterventionRequired = false;
                let pagesObserved = 0;
                let failureReason = "publisher_no_pdf";

                // Anti-detection is handled natively by Patchright (CDP leak patches, webdriver property, etc.)
                const tryCaptureBuffer = (candidateBuffer: Buffer, contentType?: string, sourceUrl?: string): boolean => {
                    const validation = classifyPdfContent(candidateBuffer, contentType);
                    if (validation.isPdf) {
                        pdfBuffer = candidateBuffer;
                        finalUrl = sourceUrl || finalUrl;
                        finalContentType = contentType || finalContentType || "application/pdf";
                        failureReason = "publisher_pdf_obtained";
                        return true;
                    }

                    if (sourceUrl) {
                        failureReason = validation.reason === "html_or_challenge_page"
                            ? "publisher_html_instead_of_pdf"
                            : validation.reason;
                        finalUrl = sourceUrl;
                        finalContentType = contentType || finalContentType;
                    }

                    return false;
                };

                const inspectPageForChallenge = async (page: any): Promise<boolean> => {
                    const pageTitle = await page.title().catch(() => "");
                    const pageHtml = await page.content().catch(() => "");
                    const pageUrl = page.url();
                    const blocked = detectBotChallenge(pageTitle, pageHtml, pageUrl);
                    if (blocked) {
                        challengeSeen = true;
                        failureReason = "publisher_challenge";
                        finalUrl = pageUrl || finalUrl;
                    }
                    return blocked;
                };

                const dismissScienceDirectInterruptors = async (page: any): Promise<void> => {
                    if (pdfBuffer || page.isClosed?.()) return;
                    if (!page.url().includes("sciencedirect.com")) return;

                    const actionState = attemptedPageActions.get(page) || {};
                    if (actionState.scienceDirectModalDismissed) return;
                    actionState.scienceDirectModalDismissed = true;
                    attemptedPageActions.set(page, actionState);

                    await page.keyboard?.press?.("Escape").catch(() => {});

                    const closeButtons = [
                        () => page.getByRole('button', { name: /close/i }).first(),
                        () => page.getByRole('button', { name: /dismiss/i }).first(),
                        () => page.getByRole('button', { name: /not now/i }).first(),
                        () => page.locator('button[aria-label*="close" i]').first(),
                        () => page.locator('[role="dialog"] button').first()
                    ];

                    for (const getLocator of closeButtons) {
                        const locator = getLocator();
                        const count = await locator.count().catch(() => 0);
                        if (count <= 0) continue;
                        await locator.click({ timeout: 1500 }).catch(() => {});
                    }
                };

                const tryBackfillPdfFromPageUrl = async (page: any): Promise<void> => {
                    if (pdfBuffer || page.isClosed?.()) return;

                    const pageUrl = page.url();
                    if (!/\.pdf(?:$|[?#])/i.test(pageUrl)) return;
                    if (attemptedPdfUrls.has(pageUrl)) return;

                    attemptedPdfUrls.add(pageUrl);
                    finalUrl = pageUrl;

                    try {
                        const response = await context.request.get(pageUrl, { timeout: 20000 });
                        const headers = response.headers();
                        const contentType = String(headers["content-type"] || "");
                        const body = Buffer.from(await response.body());
                        if (tryCaptureBuffer(body, contentType, pageUrl)) {
                            console.error(`   [${browserLabel}] Recovered a real PDF directly from the viewer tab URL.`);
                        }
                    } catch {
                        // Ignore direct fetch failures; the normal response/download listeners may still succeed.
                    }
                };

                const isScienceDirectArticleLandingPage = (pageUrl: string): boolean => {
                    return /sciencedirect\.com\/science\/article\/pii\//i.test(pageUrl)
                        && !/\/pdfft(?:[/?#]|$)/i.test(pageUrl);
                };

                const isScienceDirectPdfFlowPage = (pageUrl: string): boolean => {
                    return /sciencedirect\.com\/science\/article\/pii\/.+\/pdfft/i.test(pageUrl)
                        || /pdf\.sciencedirectassets\.com/i.test(pageUrl)
                        || /craft\/capi\/cfts\/init/i.test(pageUrl);
                };

                const openScienceDirectCandidatePage = async (candidateUrl: string): Promise<void> => {
                    if (pdfBuffer || attemptedPdfUrls.has(candidateUrl)) return;
                    attemptedPdfUrls.add(candidateUrl);
                    finalUrl = candidateUrl;

                    const targetPage = await context.newPage();
                    trackPage(targetPage);
                    await targetPage.goto(candidateUrl, { waitUntil: 'domcontentloaded', timeout: 20000 }).catch(() => {});
                };

                const tryScienceDirectViewPdfClick = async (page: any): Promise<void> => {
                    if (pdfBuffer || page.isClosed?.()) return;
                    const pageUrl = page.url();
                    if (!isScienceDirectArticleLandingPage(pageUrl)) return;
                    if (await inspectPageForChallenge(page)) return;

                    const actionState = attemptedPageActions.get(page) || {};
                    if (actionState.scienceDirectViewPdfClicked) return;

                    await dismissScienceDirectInterruptors(page);

                    const roleLocator = page.getByRole('link', { name: /View PDF/i }).first();
                    const hrefLocator = page.locator('a[href*="/pdfft"]').first();
                    const roleCount = await roleLocator.count().catch(() => 0);
                    const hrefCount = await hrefLocator.count().catch(() => 0);
                    if (roleCount <= 0 && hrefCount <= 0) return;

                    actionState.scienceDirectViewPdfClicked = true;
                    attemptedPageActions.set(page, actionState);

                    const locator = roleCount > 0 ? roleLocator : hrefLocator;
                    const href = await locator.getAttribute('href').catch(() => null);
                    const absoluteHref = href ? new URL(href, page.url()).toString() : null;
                    const popupPromise = context.waitForEvent('page', { timeout: 4000 }).catch(() => null);

                    try {
                        await locator.click({ timeout: 5000 });
                        const popup = await popupPromise;
                        if (popup) {
                            if (absoluteHref) {
                                attemptedPdfUrls.add(absoluteHref);
                            }
                            actionState.scienceDirectPdfFlowDelegated = true;
                            attemptedPageActions.set(page, actionState);
                            trackPage(popup);
                            await popup.waitForLoadState('domcontentloaded').catch(() => {});
                            return;
                        }
                    } catch {
                        // Fall through to direct new-tab navigation if the click path is intercepted.
                    }

                    if (absoluteHref) {
                        actionState.scienceDirectPdfFlowDelegated = true;
                        attemptedPageActions.set(page, actionState);
                        await openScienceDirectCandidatePage(absoluteHref);
                    }
                };

                const followScienceDirectCandidates = async (page: any): Promise<void> => {
                    if (pdfBuffer || page.isClosed?.()) return;
                    const pageUrl = page.url();
                    if (!isScienceDirectArticleLandingPage(pageUrl)) return;
                    if (await inspectPageForChallenge(page)) return;

                    const actionState = attemptedPageActions.get(page) || {};
                    if (actionState.scienceDirectPdfFlowDelegated) return;
                    let html = await page.content().catch(() => "");
                    let candidates = extractScienceDirectPdfCandidates(html, page.url());
                    if (candidates.length === 0 && !actionState.dropdownClicked) {
                        const dropdownTrigger = await page.$('#pdfLink');
                        if (dropdownTrigger) {
                            actionState.dropdownClicked = true;
                            attemptedPageActions.set(page, actionState);
                            await dropdownTrigger.click().catch(() => {});
                            await sleep(750);
                            html = await page.content().catch(() => html);
                            candidates = extractScienceDirectPdfCandidates(html, page.url());
                        }
                    }

                    for (const candidate of candidates) {
                        if (pdfBuffer || attemptedPdfUrls.has(candidate.url)) continue;
                        await openScienceDirectCandidatePage(candidate.url);
                        if (pdfBuffer) return;
                        const candidatePages = context.pages().filter((candidatePage: any) => candidatePage !== page);
                        const latestCandidatePage = candidatePages[candidatePages.length - 1];
                        if (!latestCandidatePage || latestCandidatePage.isClosed?.()) continue;
                        if (await inspectPageForChallenge(latestCandidatePage)) continue;

                        if (isScienceDirectPdfFlowPage(latestCandidatePage.url())) {
                            continue;
                        }

                        const candidateHtml = await latestCandidatePage.content().catch(() => "");
                        const redirectUrl = parseScienceDirectIntermediateRedirect(candidateHtml, latestCandidatePage.url());
                        if (redirectUrl && !attemptedPdfUrls.has(redirectUrl)) {
                            await openScienceDirectCandidatePage(redirectUrl);
                            if (pdfBuffer) return;
                            const redirectPages = context.pages().filter((candidatePage: any) => candidatePage !== page);
                            const latestRedirectPage = redirectPages[redirectPages.length - 1];
                            if (latestRedirectPage) {
                                await inspectPageForChallenge(latestRedirectPage);
                            }
                        }
                    }
                };

                const tryGenericPdfClick = async (page: any): Promise<void> => {
                    if (pdfBuffer || page.isClosed?.()) return;
                    if (page.url().includes("sciencedirect.com")) return;
                    if (await inspectPageForChallenge(page)) return;

                    const actionState = attemptedPageActions.get(page) || {};
                    if (actionState.genericClicked) return;

                    const genericLink = await page.$('a[href*="pdf"], a[title*="PDF"], a[class*="pdf"]');
                    if (genericLink) {
                        actionState.genericClicked = true;
                        attemptedPageActions.set(page, actionState);
                        await Promise.all([
                            page.waitForLoadState('domcontentloaded').catch(() => {}),
                            genericLink.click().catch(() => {})
                        ]);
                    }
                };

                const trackPage = (page: any): void => {
                    if (trackedPages.has(page)) return;
                    trackedPages.add(page);
                    pagesObserved += 1;

                    const handlePopup = (popup: any) => {
                        trackPage(popup);
                    };
                    const handleResponse = async (response: any) => {
                        const headers = response.headers();
                        const contentType = String(headers['content-type'] || "");
                        const contentDisposition = String(headers['content-disposition'] || "");
                        const responseUrl = response.url();
                        const looksPdfLike = contentType.includes('application/pdf')
                            || responseUrl.toLowerCase().includes('/pdfft')
                            || responseUrl.toLowerCase().includes('.pdf')
                            || contentDisposition.toLowerCase().includes('.pdf');
                        if (!looksPdfLike || pdfBuffer) return;

                        try {
                            const body = Buffer.from(await response.body());
                            if (tryCaptureBuffer(body, contentType, responseUrl)) {
                                console.error(`   [${browserLabel}] Browser captured a real PDF response.`);
                            }
                        } catch {
                            // Ignore response bodies that cannot be read.
                        }
                    };
                    const handleFrameNavigated = (frame: any) => {
                        if (frame !== page.mainFrame()) return;
                        const pageUrl = page.url();
                        if (pageUrl && pageUrl !== "about:blank") {
                            finalUrl = pageUrl;
                        }
                        if (/crasolve|challenge|captcha|capi\/cfts\/init/i.test(pageUrl)) {
                            challengeSeen = true;
                            failureReason = "publisher_challenge";
                        }
                    };

                    page.on('popup', handlePopup);
                    page.on('response', handleResponse);
                    page.on('framenavigated', handleFrameNavigated);
                    pageListeners.set(page, {
                        popup: handlePopup,
                        response: handleResponse,
                        frameNavigated: handleFrameNavigated
                    });
                };

                const handleContextPage = (page: any) => {
                    trackPage(page);
                };
                context.on('page', handleContextPage);

                const handleDownload = async (download: any) => {
                    const downloadUrl = download.url?.() || "";
                    const failure = await download.failure().catch(() => null);
                    if (failure) {
                        failureReason = failure;
                        return;
                    }

                    const downloadPath = await download.path().catch(() => null);
                    if (!downloadPath || !fs.existsSync(downloadPath)) {
                        failureReason = "download_path_unavailable";
                        return;
                    }

                    const body = fs.readFileSync(downloadPath);
                    if (tryCaptureBuffer(body, "application/pdf", downloadUrl)) {
                        console.error(`   [${browserLabel}] Browser completed a real PDF download.`);
                    }
                };
                (context as any).on('download', handleDownload);

                const tearDownAttempt = async (): Promise<void> => {
                    for (const [page, listeners] of pageListeners.entries()) {
                        page.off?.('popup', listeners.popup);
                        page.off?.('response', listeners.response);
                        page.off?.('framenavigated', listeners.frameNavigated);
                    }
                    pageListeners.clear();
                    context.off?.('page', handleContextPage);
                    (context as any).off?.('download', handleDownload);
                };

                trackPage(rootPage);

                await rootPage.goto(`https://doi.org/${doi}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {});
                await rootPage.waitForLoadState('networkidle').catch(() => {});

                const deadline = Date.now() + 120000;
                let challengePromptShown = false;

                while (Date.now() < deadline && !pdfBuffer) {
                    let challengeActiveThisTick = false;

                    for (const page of Array.from(trackedPages)) {
                        if (pdfBuffer || page.isClosed?.()) continue;

                        const blocked = await inspectPageForChallenge(page);
                        challengeActiveThisTick = challengeActiveThisTick || blocked;
                        if (blocked) continue;

                        await tryBackfillPdfFromPageUrl(page);
                        if (pdfBuffer) break;
                        await tryScienceDirectViewPdfClick(page);
                        if (pdfBuffer) break;
                        await followScienceDirectCandidates(page);
                        if (pdfBuffer) break;
                        await tryGenericPdfClick(page);
                        if (pdfBuffer) break;
                        await tryBackfillPdfFromPageUrl(page);
                    }

                    if (challengeSeen && !challengePromptShown) {
                        challengePromptShown = true;
                        manualInterventionRequired = true;
                        console.error(`   [${browserLabel}] Waiting for manual verification or a real PDF signal...`);
                    }

                    if (!challengeActiveThisTick && challengeSeen && !pdfBuffer && failureReason === "publisher_challenge") {
                        failureReason = "challenge_cleared_but_pdf_not_yet_observed";
                    }

                    await sleep(1000);
                }

                if (pdfBuffer) {
                    if (retainWindow && closePdfPageAfterCapture) {
                        await closeSecondaryBrowserPages(context, rootPage);
                    }
                    await tearDownAttempt();
                    if (!retainWindow) {
                        await session.cleanup().catch(() => {});
                    } else {
                        await rootPage.bringToFront().catch(() => {});
                        if (reusableBrowserWindow) reusableBrowserWindow.lastUsedAt = Date.now();
                    }
                    return {
                        source: `Headless Browser (${browserLabel})`,
                        outcome: "publisher_pdf_obtained",
                        pdfBuffer,
                        diagnostic: buildFetchDiagnostic({
                            strategy,
                            source: `Headless Browser (${browserLabel})`,
                            outcome: "publisher_pdf_obtained",
                            startedAt,
                            challengeSeen,
                            manualInterventionRequired,
                            finalUrl: finalUrl || rootPage.url(),
                            contentType: finalContentType || "application/pdf",
                            pagesObserved
                        })
                    };
                }

                await tearDownAttempt();
                if (!retainWindow) {
                    await session.cleanup().catch(() => {});
                } else {
                    await rootPage.bringToFront().catch(() => {});
                    if (reusableBrowserWindow) reusableBrowserWindow.lastUsedAt = Date.now();
                }

                const outcome: FetchOutcome = failureReason === "publisher_html_instead_of_pdf"
                    ? "publisher_html_instead_of_pdf"
                    : challengeSeen
                        ? "publisher_challenge"
                        : "timed_out";

                return {
                    source: `Headless Browser (${browserLabel})`,
                    outcome,
                    diagnostic: buildFetchDiagnostic({
                        strategy,
                        source: `Headless Browser (${browserLabel})`,
                        outcome,
                        startedAt,
                        challengeSeen,
                        manualInterventionRequired,
                        finalUrl: finalUrl || rootPage.url(),
                        contentType: finalContentType,
                        pagesObserved,
                        failureReason
                    })
                };
            } catch(e) {
                if (session) {
                    if (!retainWindow) {
                        try { await session.cleanup(); } catch {}
                    }
                }
                return {
                    source: `Headless Browser (${browserLabel})`,
                    outcome: "timed_out",
                    diagnostic: buildFetchDiagnostic({
                        strategy,
                        source: `Headless Browser (${browserLabel})`,
                        outcome: "timed_out",
                        startedAt,
                        failureReason: e instanceof Error ? e.message : String(e)
                    })
                };
            }
        };
        return await launchAndAttempt();
    } catch(e: any) {
        console.error(`Headless Browser Exception: ${e.message}`);
    }
    return {
        source: `Headless Browser (${browserLabel})`,
        outcome: "timed_out",
        diagnostic: buildFetchDiagnostic({
            strategy,
            source: `Headless Browser (${browserLabel})`,
            outcome: "timed_out",
            startedAt,
            failureReason: "Unhandled headless browser exception"
        })
    };
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
        const workerDir = resolveMarkerWorkerDirectory();
        const pythonExec = resolveMarkerPython(workerDir);
        const workerPy = path.join(workerDir, "worker.py");
        if (!fs.existsSync(workerPy)) {
            console.error(`   [Marker] Worker scaffold not found at ${workerDir}. Set extract.parsing.markerWorkerDirectory to the marker-worker folder itself, then run the install script there.`);
            return null;
        }
        if (!pythonExec) {
            console.error(`   [Marker] Worker found at ${workerDir}, but no local Python env is available. Run the install script in that marker-worker directory.`);
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
    } else if (name === "search_saved_papers") {
        const query = String(args?.query || "").trim();
        const requestedLimit = Number(args?.limit ?? 5);
        const limit = Number.isFinite(requestedLimit) && requestedLimit > 0
            ? Math.min(8, Math.floor(requestedLimit))
            : 5;

        if (!query) {
            return {
                content: [{ type: "text", text: "Error: search_saved_papers requires a non-empty 'query'." }],
                isError: true
            };
        }

        const result = await searchSavedPapers(query, limit);
        return {
            content: [
                {
                    type: "text",
                    text: buildSavedPaperSearchText(result)
                }
            ],
            structuredContent: result
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
        let savedPaperArtifacts: PaperSaveResult | null = null;
        const fetchDiagnostics: FetchAttemptDiagnostic[] = [];
        
        // Define our waterfall strategies in config order
        const strategyFactories: Record<string, { name: string; run: () => Promise<FetchResult | null> }> = {
            TDM: {
                name: "TDM",
                run: async () => {
                    let bestFallback: FetchResult | null = null;
                    for (const tdmName of tdmOrder) {
                        if (tdmEnabled[tdmName] === false) continue;
                        let res: FetchResult | null = null;
                        if (tdmName === "Elsevier") res = await fetchFromElsevier(doi);
                        if (tdmName === "Springer") res = await fetchFromSpringer(doi);

                        if (isResultFullText(res)) return res;
                        if (fallbackResultRank(res) > fallbackResultRank(bestFallback)) {
                            bestFallback = res;
                        }
                    }
                    return bestFallback;
                }
            },
            OA: {
                name: "OA Aggregators",
                run: async () => await fetchFromOA(doi)
            },
            SciHub: {
                name: "SciHub",
                run: async () => await fetchFromSciHub(doi, extractConfig)
            },
            Headless: {
                name: "Headless Scraper",
                run: async () => await fetchFromHeadlessBrowser(doi, extractConfig)
            }
        };

        const fetchStrategies = fetchStratOrder
            .filter((strategyName) => fetchStratEnabled[strategyName] !== false && strategyFactories[strategyName])
            .map((strategyName) => strategyFactories[strategyName]);

        for (const strategy of fetchStrategies) {
            console.error(`=> Executing Fetch Strategy: [${strategy.name}]`);
            try {
                const fetchRes = await strategy.run();
                if (!fetchRes) continue;
                if (fetchRes.diagnostic) {
                    fetchDiagnostics.push(fetchRes.diagnostic);
                    if (isDebugEnabled()) {
                        console.error(`[Benchmark] ${benchmarkLogLine(doi, fetchRes.diagnostic)}`);
                    }
                }

                let parsedMarkdown = "";

                // Has the API already provided raw text natively?
                if (fetchRes.text && fetchRes.text.length > 0) {
                    console.error(`   [${strategy.name}] successfully procured native text! (Length: ${fetchRes.text.length})`);
                    parsedMarkdown = fetchRes.text;
                } 
                // Or do we have a PDF Buffer that needs Progressive Parsing?
                else if (fetchRes.pdfBuffer) {
                    const validation = classifyPdfContent(
                        fetchRes.pdfBuffer,
                        fetchRes.diagnostic?.content_type || fetchRes.accessStatus
                    );
                    if (!validation.isPdf) {
                        console.error(`   [${strategy.name}] Downloaded content is not a valid PDF (${validation.reason}). Skipping.`);
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
                } else if (fetchRes.outcome === "metadata_only") {
                    console.error(`   [${strategy.name}] retained metadata-only signal and will continue down the waterfall.`);
                    continue;
                } else {
                    console.error(`   [${strategy.name}] produced no full text (${fetchRes.outcome}); trying next strategy.`);
                    continue;
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
                        savedPaperArtifacts = await savePaperMarkdown({
                            doi,
                            title: expectedTitle || (fetchRes.metadata?.title !== undefined ? String(fetchRes.metadata.title) : undefined),
                            source: fetchRes.source,
                            markdown: parsedMarkdown,
                            frontMatter: {
                                publisher: fetchRes.metadata?.publisher || (publisher ? publisher : undefined),
                                pii: fetchRes.metadata?.pii,
                                eid: fetchRes.metadata?.eid,
                                openaccess: fetchRes.metadata?.openaccess,
                                extraction_status: fetchRes.metadata?.extraction_status || fetchRes.accessStatus,
                                fetch_outcome: fetchRes.outcome
                            },
                            assetHints: fetchRes.assetHints
                        });
                        savedMarkdownPath = savedPaperArtifacts.markdownPath;
                        console.error(`📚 Saved Markdown for RAG indexing: ${savedMarkdownPath}`);
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
             const diagnosticsText = isDebugEnabled()
                 ? formatFetchDiagnosticsText(fetchDiagnostics)
                 : "";
             return {
                 content: [{
                     type: "text",
                     text: [
                         `Error: Failed to extract valid full text for DOI: ${doi} after exhausting all configured waterfall methods.`,
                         `The paywall might be too strong, the publisher may still require manual verification, or the network is blocked.`,
                         diagnosticsText ? `Fetch benchmark:\n${diagnosticsText}` : ""
                     ].filter(Boolean).join('\n\n')
                 }],
                 isError: true
             };
        }

        if (!savedMarkdownPath) {
            return {
                content: [{ type: "text", text: `Error: Extracted text for DOI ${doi} but failed to persist it into the Markdown directory.` }],
                isError: true
            };
        }

        const summary = buildPaperSavedSummary({
            doi,
            title: expectedTitle,
            source: successfulSource,
            text: fs.readFileSync(savedMarkdownPath, 'utf-8'),
            absolutePath: savedMarkdownPath,
            assetRecords: savedPaperArtifacts?.assetRecords,
            assetsDirectoryPath: savedPaperArtifacts?.assetsDirectoryPath,
            assetsManifestPath: savedPaperArtifacts?.assetsManifestPath
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
        let savedPaperArtifacts: PaperSaveResult | null = null;
        if (doi) {
            try {
                savedPaperArtifacts = await savePaperMarkdown({
                    doi,
                    title: expectedTitle,
                    source: "Local PDF (parse_pdf_file)",
                    markdown: parsedMarkdown
                });
                savedPath = savedPaperArtifacts.markdownPath;
                console.error(`📚 Saved Markdown for RAG indexing: ${savedPath}`);
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
                absolutePath: savedPath,
                assetRecords: savedPaperArtifacts?.assetRecords,
                assetsDirectoryPath: savedPaperArtifacts?.assetsDirectoryPath,
                assetsManifestPath: savedPaperArtifacts?.assetsManifestPath
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
                "Compact saved-paper search via search_saved_papers (semantic through local-rag CLI when available, lexical fallback otherwise)",
                "Deep paper reading via read_saved_paper and grados://papers/{safe_doi}",
                "Full-text extraction via TDM APIs, Open Access, Sci-Hub, and headless browser",
                "Elsevier API-first full-text capture with sidecar figure/table asset manifests",
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
            localRag: {
                enabled: config?.localRag?.enabled !== false,
                papersBaseDir: getPapersDirectory(),
                dbPath: getLocalRagDbPath(),
                cacheDir: getLocalRagCacheDir(),
                modelName: getLocalRagModelName(),
                integratedSearchTool: "search_saved_papers"
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
