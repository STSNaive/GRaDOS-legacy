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
import puppeteer from 'puppeteer-core';
import FormData from 'form-data';
import { PDFParse } from 'pdf-parse';
import { spawn } from 'node:child_process';

dotenv.config();

// Apply a stealthy global User-Agent to evade basic 403 Forbidden blocks
axios.defaults.headers.common['User-Agent'] = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

// --- Path Resolution ---
// PACKAGE_ROOT: where grados is installed (contains marker-worker/, mcp-config.example.json, etc.)
// In dist/index.js, __dirname is <install>/dist, so the package root is one level up.
const PACKAGE_ROOT = path.resolve(__dirname, "..");

// Resolve config file path: --config <path> > GRADOS_CONFIG_PATH env > cwd/mcp-config.json
function resolveConfigPath(): string {
    const argIdx = process.argv.indexOf("--config");
    if (argIdx !== -1 && process.argv[argIdx + 1]) {
        return path.resolve(process.argv[argIdx + 1]);
    }
    if (process.env.GRADOS_CONFIG_PATH) {
        return path.resolve(process.env.GRADOS_CONFIG_PATH);
    }
    return path.join(process.cwd(), "mcp-config.json");
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
    console.error("[GRaDOS] WARNING: academicEtiquetteEmail is not configured. Crossref/Unpaywall may throttle requests. Set a real email in mcp-config.json.");
}

// Helpers to get API keys (Config file overrides .env, which is the MCPB path)
const getApiKey = (keyName: string) => config?.apiKeys?.[keyName] || process.env[keyName];
const getEtiquetteEmail = () => config?.academicEtiquetteEmail || process.env.ACADEMIC_ETIQUETTE_EMAIL || "admin@example.com";

// Initialize Server
const server = new Server(
    {
        name: "GRaDOS",
        version: "1.0.0",
    },
    {
        capabilities: {
            tools: {},
            resources: {},
        },
    }
);

// --- Types ---
interface PaperMetadata {
    title: string;
    doi: string;
    abstract?: string;
    publisher?: string;
    authors?: string[];
    year?: string;
    url?: string;
    source: string;
}

// Mock Search Functions (Require API Keys)
async function searchWebOfScience(query: string, limit: number): Promise<PaperMetadata[]> {
    const apiKey = getApiKey("WOS_API_KEY");
    if (!apiKey) return [];
    try {
        const response = await axios.get("https://api.clarivate.com/apis/wos-starter/v1/documents", {
            params: { q: `TS=(${query})`, limit: limit },
            headers: { "X-ApiKey": apiKey }
        });
        const hits = response.data?.hits || [];
        return hits.map((hit: any) => ({
            title: hit.title || "Unknown Title",
            doi: hit.identifiers?.doi || "",
            abstract: hit.abstract,
            publisher: hit.source?.sourceTitle,
            authors: hit.names?.authors ? hit.names.authors.map((a: any) => a.displayName) : [],
            year: hit.source?.publishYear?.toString(),
            url: hit.links?.record,
            source: "Web of Science"
        })).filter((p: PaperMetadata) => p.doi !== "");
    } catch(e) { console.error("WoS search failed", e); return []; }
}

async function searchElsevier(query: string, limit: number): Promise<PaperMetadata[]> {
    const apiKey = getApiKey("ELSEVIER_API_KEY");
    if (!apiKey) return [];
    try {
        const response = await axios.get("https://api.elsevier.com/content/search/scopus", {
            params: { query: query, count: Math.min(limit, 25), view: "COMPLETE" },
            headers: { "X-ELS-APIKey": apiKey, "Accept": "application/json" }
        });
        const entries = response.data?.["search-results"]?.entry || [];
        return entries.map((item: any) => ({
            title: item["dc:title"] || "Unknown Title",
            doi: item["prism:doi"],
            abstract: item["dc:description"],
            publisher: item["prism:publicationName"],
            authors: item.author ? item.author.map((a: any) => a.authname) : [],
            year: item["prism:coverDate"]?.split("-")?.[0],
            url: item["prism:url"],
            source: "Elsevier (Scopus)"
        })).filter((p: PaperMetadata) => !!p.doi);
    } catch(e) { console.error("Elsevier search failed", e); return []; }
}

async function searchSpringer(query: string, limit: number): Promise<PaperMetadata[]> {
    const apiKey = getApiKey("SPRINGER_meta_API_KEY");
    if (!apiKey) return [];
    try {
        const response = await axios.get("https://api.springernature.com/meta/v2/json", {
            params: { q: `keyword:"${query}"`, p: limit, api_key: apiKey }
        });
        const records = response.data?.records || [];
        return records.map((item: any) => ({
            title: item.title || "Unknown Title",
            doi: item.doi,
            abstract: item.abstract,
            publisher: item.publisher,
            authors: item.creators ? item.creators.map((c: any) => c.creator) : [],
            year: item.publicationDate?.split("-")?.[0],
            url: item.url?.[0]?.value,
            source: "Springer Nature"
        })).filter((p: PaperMetadata) => !!p.doi);
    } catch(e) { console.error("Springer search failed", e); return []; }
}

// Real Implementations (Open / Public APIs)
async function searchCrossref(query: string, limit: number): Promise<PaperMetadata[]> {
    try {
        const etiquetteEmail = getEtiquetteEmail();
        const response = await axios.get("https://api.crossref.org/works", {
            params: {
                query: query,
                rows: limit,
                select: "DOI,title,abstract,publisher,author,published-print,URL"
            },
            headers: {
                // Etiquette for Crossref API, but still maintaining stealth
                "User-Agent": `GRaDOS/1.0 (mailto:${etiquetteEmail}) Mozilla/5.0 Chrome/120.0.0.0` 
            }
        });

        if (!response.data?.message?.items) return [];

        return response.data.message.items.map((item: any) => ({
            title: item.title?.[0] || "Unknown Title",
            doi: item.DOI,
            abstract: item.abstract ? item.abstract.replace(/(<([^>]+)>)/gi, "") : undefined, // Strip basic JATS XML tags if present
            publisher: item.publisher,
            authors: item.author?.map((a: any) => `${a.given} ${a.family}`),
            year: item["published-print"]?.["date-parts"]?.[0]?.[0]?.toString(),
            url: item.URL,
            source: "Crossref"
        }));
    } catch (e) {
        console.error("Crossref search failed", e);
        return [];
    }
}

async function searchPubMed(query: string, limit: number): Promise<PaperMetadata[]> {
    try {
        // 1. ESearch to get PubMed IDs (PMIDs)
        const searchRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi", {
            params: {
                db: "pubmed",
                term: query,
                retmode: "json",
                retmax: limit
            }
        });
        const pmids = searchRes.data?.esearchresult?.idlist;
        if (!pmids || pmids.length === 0) return [];

        // 2. ESummary to get metadata for those PMIDs
        const summaryRes = await axios.get("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi", {
            params: {
                db: "pubmed",
                id: pmids.join(","),
                retmode: "json"
            }
        });

        // 3. EFetch (XML) to get abstracts (not available in ESummary)
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
                // Handle both single and structured AbstractText elements
                const abstractMatch = block.match(/<Abstract>([\s\S]*?)<\/Abstract>/);
                if (pmidMatch && abstractMatch) {
                    const rawAbstract = abstractMatch[1]
                        .replace(/<\/?AbstractText[^>]*>/g, ' ')
                        .replace(/<[^>]+>/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                    if (rawAbstract.length > 0) {
                        abstractMap.set(pmidMatch[1], rawAbstract);
                    }
                }
            }
        } catch(e) {
            console.error("PubMed EFetch for abstracts failed, continuing without abstracts.", e);
        }

        const results: PaperMetadata[] = [];
        const resultDict = summaryRes.data?.result || {};

        for (const pmid of pmids) {
            const paper = resultDict[pmid];
            if (!paper) continue;
            let doi = "";
            const articleIds = paper.articleids || [];
            const doiObj = articleIds.find((idObj: any) => idObj.idtype === "doi");
            if (doiObj) doi = doiObj.value;

            if (doi) {
                 results.push({
                    title: paper.title,
                    doi: doi,
                    abstract: abstractMap.get(pmid),
                    publisher: paper.fulljournalname,
                    authors: paper.authors?.map((a: any) => a.name),
                    year: paper.pubdate?.split(" ")?.[0],
                    url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/`,
                    source: "PubMed"
                });
            }
        }
        return results;
    } catch (e) {
        console.error("PubMed search failed", e);
        return [];
    }
}

// Tool Listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "search_academic_papers",
                description: "Searches multiple academic databases sequentially in priority order (Crossref, PubMed, WoS, Elsevier, Springer) for a given query and returns a deduplicated list of papers with metadata (DOIs, Abstracts).",
                inputSchema: {
                    type: "object",
                    properties: {
                        query: {
                            type: "string",
                            description: "The search query (e.g., 'large language models in multi-agent reinforcement learning')."
                        },
                        limit: {
                            type: "number",
                            description: "Maximum number of results to return.",
                            default: 10
                        }
                    },
                    required: ["query"]
                }
            },
            {
                name: "extract_paper_full_text",
                description: "Given a DOI, attempts to fetch the full text of the paper using a waterfall strategy. Returns markdown-formatted text. Includes QA validation to ensure it's not a paywall.",
                inputSchema: {
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
                    required: ["doi"]
                }
            },
            {
                name: "save_paper_to_zotero",
                description: "Saves a paper's bibliographic metadata to the Zotero web library. Call this after synthesis for each paper that was cited in the final answer. Requires ZOTERO_API_KEY and zotero.libraryId in mcp-config.json.",
                inputSchema: {
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
                    required: ["doi", "title"]
                }
            }
        ]
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

// --- Fetch Strategy (Phase 4: Headless Browser Fallback) ---
async function fetchFromHeadlessBrowser(doi: string, extractConfig: any): Promise<FetchResult | null> {
    const headlessConf = extractConfig?.headlessBrowser || {};
    const browserStr = headlessConf.browser || "msedge";
    const interactiveCaptchaHelp = headlessConf.interactiveCaptchaHelp !== false;
    
    let executablePath = "";
    if (browserStr === "msedge") {
        executablePath = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
    } else if (browserStr === "chrome") {
        executablePath = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
    } else if (browserStr === "firefox") {
        executablePath = "C:\\Program Files\\Mozilla Firefox\\firefox.exe";
    }
    
    if (!fs.existsSync(executablePath)) {
        console.error(`Configured browser ${browserStr} not found at ${executablePath}. Headless failed.`);
        return null; 
    }

    try {
        console.error(`Launching ${browserStr} Headless for DOI: ${doi}...`);
        let pdfBuffer: Buffer | null = null;
        
        const launchAndAttempt = async (isHeadless: boolean): Promise<boolean> => {
            const browser = await puppeteer.launch({ executablePath, headless: isHeadless, defaultViewport: null });
            try {
                const page = await browser.newPage();
                let foundCaptcha = false;
                
                // 1. Setup Interceptor to catch any downloaded PDF
                page.on('response', async (response) => {
                    const contentType = response.headers()['content-type'];
                    if (contentType && contentType.includes('application/pdf')) {
                        try {
                            pdfBuffer = await response.buffer();
                            console.error(`   [Edge] Browser successfully intercepted PDF!`);
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
                    console.error("   [Edge] Anti-Bot / CAPTCHA detected in Headless mode!");
                    await browser.close();
                    return true; // Return true to request retry in visible mode
                }

                // 3. Try to click generic "Download PDF" buttons on publisher page
                if (!pdfBuffer) {
                    const link = await page.$('a[href*="pdf"], a[title*="PDF"], a[class*="pdf"]').catch(()=>null);
                    if (link) {
                        console.error("   [Edge] Clicking generic PDF link on publisher page...");
                        await Promise.all([
                            page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(()=>{}),
                            link.click().catch(()=>{})
                        ]);
                    }
                }
                
                // 4. Try SciHub inside the browser as a robust fallback
                if (!pdfBuffer) {
                    console.error("   [Edge] Publisher PDF not found. Falling back to Browser Sci-Hub...");
                    const mirrorFile = extractConfig?.sciHub?.mirrorUrlFile || "./scihub-mirrors.txt";
                    const activeMirror = await getWorkingSciHubMirror(mirrorFile, "https://sci-hub.ru", false);
                    await page.goto(`${activeMirror}/${doi}`, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(()=>{});
                    
                    const shHtml = await page.content();
                    if (isHeadless && (shHtml.includes('cf-browser') || shHtml.includes('captcha'))) {
                         console.error("   [Edge] Sci-Hub is also protected by Cloudflare!");
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
                    console.error("   [Edge] Waiting 20 seconds for you to manually trigger the PDF download...");
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
            return { source: "Headless Browser (Edge)", pdfBuffer };
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
        const pythonExec = path.join(workerDir, ".venv", "Scripts", "python.exe");
        const workerPy = path.join(workerDir, "worker.py");
        if (!fs.existsSync(pythonExec) || !fs.existsSync(workerPy)) {
            console.error(`   [Marker] Worker is not installed at ${workerDir}.`);
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

    if (!apiKey) return { success: false, error: "ZOTERO_API_KEY is not configured in mcp-config.json apiKeys." };
    if (!libraryId) return { success: false, error: "zotero.libraryId is not configured in mcp-config.json." };

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
        const limit = Number(args?.limit || 10);

        // DEFAULT CONFIG IF NOT SET
        const searchOrder = config?.search?.order || ["Elsevier", "Springer", "WebOfScience", "PubMed", "Crossref"];
        const searchEnabled = config?.search?.enabled || {
             "Elsevier": true, "Springer": true, "WebOfScience": true, "Crossref": true, "PubMed": true
        };

        const serviceMap: { [key: string]: (q: string, l: number) => Promise<PaperMetadata[]> } = {
            "WebOfScience": searchWebOfScience,
            "Elsevier": searchElsevier,
            "Springer": searchSpringer,
            "Crossref": searchCrossref,
            "PubMed": searchPubMed
        };

        // WATERFALL SEARCH: search sources in priority order, deduplicate incrementally, stop when we have enough
        const uniquePapersMap = new Map<string, PaperMetadata>();

        for (const serviceName of searchOrder) {
            if (searchEnabled[serviceName] === false) continue;

            const searchFunc = serviceMap[serviceName];
            if (!searchFunc) continue;

            console.error(`Searching ${serviceName}...`);
            try {
                const results = await searchFunc(query, limit);
                // Incrementally deduplicate by DOI (prefer entries with abstracts)
                for (const paper of results) {
                    const lowerDoi = paper.doi.toLowerCase();
                    if (!uniquePapersMap.has(lowerDoi) || (!uniquePapersMap.get(lowerDoi)?.abstract && paper.abstract)) {
                        uniquePapersMap.set(lowerDoi, paper);
                    }
                }
                console.error(`${serviceName} returned ${results.length} results. Unique total: ${uniquePapersMap.size}.`);

                // Stop as soon as we have enough unique papers
                if (uniquePapersMap.size >= limit) {
                    console.error(`Reached limit (${limit} unique). Skipping remaining sources.`);
                    break;
                }
            } catch (err) {
                console.error(`Error searching ${serviceName}:`, err);
            }
        }

        let finalResults = Array.from(uniquePapersMap.values());

        // Trim to limit
        if (finalResults.length > limit) {
             finalResults = finalResults.slice(0, limit);
        }

        // Format as Markdown for the LLM
        let formattedString = `Found ${finalResults.length} unique papers for query: "${query}"\n\n`;
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
             formattedString = `No academic papers found for query: "${query}". Please broaden your search terms.`;
        }

        return {
            content: [
                {
                    type: "text",
                    text: formattedString
                }
            ]
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
                    const downloadDir = extractConfig?.downloadDirectory ? path.resolve(PROJECT_ROOT, extractConfig.downloadDirectory) : path.join(PROJECT_ROOT, "downloads");
                    if (!fs.existsSync(downloadDir)) fs.mkdirSync(downloadDir, { recursive: true });
                    
                    const safeDoi = doi.replace(/[^a-z0-9]/gi, '_');
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
                        const papersDir = extractConfig?.papersDirectory ? path.resolve(PROJECT_ROOT, extractConfig.papersDirectory) : path.join(PROJECT_ROOT, "papers");
                        if (!fs.existsSync(papersDir)) fs.mkdirSync(papersDir, { recursive: true });
                        const safeDoi = doi.replace(/[^a-z0-9]/gi, '_');
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
                        console.error(`📚 Saved Markdown for RAG indexing: ${mdFilePath}`);
                    } catch (saveErr: any) {
                        console.error(`⚠️ Failed to save Markdown (non-fatal): ${saveErr.message}`);
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

        return {
            content: [
                {
                    type: "text",
                    text: `# Extracted Paper Full Text [Source: ${successfulSource}]
## DOI: ${doi}

${finalExtractedText}`
                }
            ]
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
                content: [{ type: "text", text: `✅ Saved to Zotero: "${title}" (DOI: ${doi}) — item key: ${result.itemKey}` }]
            };
        } else {
            return {
                content: [{ type: "text", text: `❌ Failed to save to Zotero: ${result.error}` }],
                isError: true
            };
        }
    }

    return {
        content: [{ type: "text", text: `Error: Unknown tool "${name}". Available tools: search_academic_papers, extract_paper_full_text, save_paper_to_zotero.` }],
        isError: true
    };
});

// --- MCP Resources ---
// Phase 1: Static read-only resources for service discovery and status.
// These allow clients that support resources (Claude Code @-mentions, Codex resource wrappers)
// to discover GRaDOS capabilities even without tools/list.

const GRADOS_VERSION = "0.2.1";

server.setRequestHandler(ListResourcesRequestSchema, async () => {
    return {
        resources: [
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
                description: "Read-only mirror of available tools with names, descriptions, and parameter schemas",
                mimeType: "application/json"
            }
        ]
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
                "Full-text extraction via TDM APIs, Open Access, Sci-Hub, and headless browser",
                "Progressive PDF parsing (LlamaParse → Marker → Native)",
                "QA validation to reject paywalls and truncated content",
                "Automatic Markdown output with YAML front-matter",
                "Zotero web library integration for citation management"
            ],
            tools: [
                { name: "search_academic_papers", purpose: "Search academic databases and return deduplicated paper metadata" },
                { name: "extract_paper_full_text", purpose: "Fetch and parse full-text paper content by DOI" },
                { name: "save_paper_to_zotero", purpose: "Save cited paper metadata to Zotero web library" }
            ],
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
            configPath: CONFIG_PATH,
            projectRoot: PROJECT_ROOT
        };
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(about, null, 2) }]
        };
    }

    if (uri === "grados://status") {
        const extractConfig = config?.extract || {};
        const papersDir = extractConfig?.papersDirectory
            ? path.resolve(PROJECT_ROOT, extractConfig.papersDirectory)
            : path.join(PROJECT_ROOT, "papers");
        const downloadDir = extractConfig?.downloadDirectory
            ? path.resolve(PROJECT_ROOT, extractConfig.downloadDirectory)
            : path.join(PROJECT_ROOT, "downloads");

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
            fetchStrategy: extractConfig?.fetchStrategy?.order || ["TDM", "OA", "SciHub", "Headless"],
            parsingOrder: extractConfig?.parsing?.order || ["LlamaParse", "Marker", "Native"]
        };
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(status, null, 2) }]
        };
    }

    if (uri === "grados://tools") {
        const tools = [
            {
                name: "search_academic_papers",
                description: "Searches multiple academic databases sequentially in priority order for a given query and returns a deduplicated list of papers with metadata (DOIs, Abstracts).",
                parameters: {
                    query: { type: "string", required: true, description: "The search query" },
                    limit: { type: "number", required: false, default: 10, description: "Maximum number of results to return" }
                },
                returns: "Markdown-formatted list of papers with DOI, title, authors, year, abstract",
                commonFailures: ["No API key for a specific database (gracefully skipped)", "Network timeout", "Database rate limiting"]
            },
            {
                name: "extract_paper_full_text",
                description: "Given a DOI, attempts to fetch the full text using a waterfall strategy (TDM → OA → Sci-Hub → Headless). Returns markdown-formatted text with QA validation.",
                parameters: {
                    doi: { type: "string", required: true, description: "The DOI of the paper" },
                    publisher: { type: "string", required: false, description: "Publisher name to optimize extraction" },
                    expected_title: { type: "string", required: false, description: "Paper title for QA validation" }
                },
                returns: "Full-text paper content in Markdown. Auto-saves .md to papers directory and .pdf to downloads directory.",
                commonFailures: ["Paywall blocks all strategies", "PDF parsing fails", "QA validation rejects truncated content"]
            },
            {
                name: "save_paper_to_zotero",
                description: "Saves a paper's bibliographic metadata to the Zotero web library. Requires ZOTERO_API_KEY and zotero.libraryId in config.",
                parameters: {
                    doi: { type: "string", required: true, description: "The DOI of the paper" },
                    title: { type: "string", required: true, description: "The full title" },
                    authors: { type: "array", required: false, description: "List of author names" },
                    abstract: { type: "string", required: false, description: "Paper abstract" },
                    journal: { type: "string", required: false, description: "Journal name" },
                    year: { type: "string", required: false, description: "Publication year" },
                    url: { type: "string", required: false, description: "URL to paper landing page" },
                    tags: { type: "array", required: false, description: "Tags/keywords" },
                    collection_key: { type: "string", required: false, description: "Zotero collection key override" }
                },
                returns: "Confirmation with Zotero item key",
                commonFailures: ["ZOTERO_API_KEY not configured", "libraryId not set", "Network error"]
            }
        ];
        return {
            contents: [{ uri, mimeType: "application/json", text: JSON.stringify(tools, null, 2) }]
        };
    }

    return {
        contents: [{ uri, mimeType: "text/plain", text: `Unknown resource URI: ${uri}` }]
    };
});

// CRITICAL: Must implement resources/templates/list even if empty.
// Codex disconnects ALL MCP servers if this returns -32601 (Method not found). See: github.com/openai/codex/issues/14454
server.setRequestHandler(ListResourceTemplatesRequestSchema, async () => {
    return { resourceTemplates: [] };
});

// --- CLI: --init flag to bootstrap mcp-config.json ---
if (process.argv.includes("--init")) {
    const exampleSrc = path.join(__dirname, "..", "mcp-config.example.json");
    const destPath = path.join(process.cwd(), "mcp-config.json");

    if (fs.existsSync(destPath)) {
        console.log("mcp-config.json already exists in this directory. No changes made.");
    } else if (!fs.existsSync(exampleSrc)) {
        console.error("Could not find mcp-config.example.json in the package. Please create mcp-config.json manually.");
    } else {
        fs.copyFileSync(exampleSrc, destPath);
        console.log(`Created mcp-config.json in ${process.cwd()}`);
        console.log("Edit this file to add your API keys and configure GRaDOS.");
    }
    process.exit(0);
}

// Start Server
async function main() {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("GRaDOS MCP Node.js server running on stdio");
}

main().catch(console.error);
