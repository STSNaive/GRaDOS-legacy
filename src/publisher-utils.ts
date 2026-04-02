import * as cheerio from "cheerio";

export type FetchOutcome =
    | "native_full_text"
    | "metadata_only"
    | "publisher_challenge"
    | "publisher_pdf_obtained"
    | "publisher_html_instead_of_pdf"
    | "scihub_no_pdf"
    | "scihub_challenge"
    | "timed_out"
    | "no_result";

export interface FetchAttemptDiagnostic {
    strategy: string;
    source: string;
    outcome: FetchOutcome;
    duration_ms: number;
    challenge_seen?: boolean;
    manual_intervention_required?: boolean;
    final_url?: string;
    content_type?: string;
    pages_observed?: number;
    failure_reason?: string;
}

export interface ScienceDirectPdfCandidate {
    url: string;
    source:
        | "citation_pdf_url"
        | "pdfLink_href"
        | "embedded_object"
        | "dropdown_menu"
        | "json_url_metadata"
        | "canonical_pdfft"
        | "fallback_download_button";
}

export interface PdfValidationResult {
    isPdf: boolean;
    header: string;
    reason: string;
    contentType?: string;
}

export interface ElsevierMetadataSignal {
    doi: string;
    title?: string;
    abstract?: string;
    pii?: string;
    eid?: string;
    scidir?: string;
    openaccess?: string;
    publisher: "Elsevier";
}

function normalizeWhitespace(value: string): string {
    return value.replace(/\s+/g, " ").trim();
}

function absolutizeUrl(rawUrl: string | undefined, pageUrl: string): string | undefined {
    if (!rawUrl) return undefined;
    const trimmed = rawUrl.trim();
    if (!trimmed) return undefined;
    if (trimmed.startsWith("//")) return `https:${trimmed}`;

    try {
        return new URL(trimmed, pageUrl).toString();
    } catch {
        return undefined;
    }
}

function addCandidate(
    bucket: ScienceDirectPdfCandidate[],
    seen: Set<string>,
    rawUrl: string | undefined,
    pageUrl: string,
    source: ScienceDirectPdfCandidate["source"]
): void {
    const absoluteUrl = absolutizeUrl(rawUrl, pageUrl);
    if (!absoluteUrl || seen.has(absoluteUrl)) return;
    seen.add(absoluteUrl);
    bucket.push({ url: absoluteUrl, source });
}

export function detectBotChallenge(pageTitle: string, html: string, pageUrl: string = ""): boolean {
    const normalizedTitle = pageTitle.toLowerCase();
    const normalizedHtml = html.toLowerCase();
    const normalizedUrl = pageUrl.toLowerCase();

    return [
        normalizedTitle.includes("just a moment"),
        normalizedTitle.includes("attention required"),
        normalizedTitle.includes("are you a robot"),
        normalizedTitle.includes("请稍候"),
        normalizedHtml.includes("cf-browser"),
        normalizedHtml.includes("challenges.cloudflare.com"),
        normalizedHtml.includes("captcha"),
        normalizedHtml.includes("recaptcha"),
        normalizedHtml.includes("are you a robot"),
        normalizedUrl.includes("challenges.cloudflare.com")
    ].some(Boolean);
}

export function extractScienceDirectPdfCandidates(html: string, pageUrl: string): ScienceDirectPdfCandidate[] {
    const $ = cheerio.load(html);
    const candidates: ScienceDirectPdfCandidate[] = [];
    const seen = new Set<string>();

    addCandidate(candidates, seen, $('meta[name="citation_pdf_url"]').attr("content"), pageUrl, "citation_pdf_url");
    addCandidate(candidates, seen, $("#pdfLink").attr("href"), pageUrl, "pdfLink_href");
    addCandidate(candidates, seen, $(".PdfEmbed > object").attr("data"), pageUrl, "embedded_object");
    addCandidate(candidates, seen, $(".PdfDropDownMenu a[href]").first().attr("href"), pageUrl, "dropdown_menu");
    addCandidate(candidates, seen, $(".pdf-download-btn-link").attr("href"), pageUrl, "fallback_download_button");

    const jsonPayload = $('script[type="application/json"]').first().text();
    if (jsonPayload) {
        try {
            const parsed = JSON.parse(jsonPayload);
            const urlMetadata = parsed?.article?.pdfDownload?.urlMetadata;
            const pathSegment = urlMetadata?.path;
            const pdfExtension = urlMetadata?.pdfExtension;
            const pii = urlMetadata?.pii;
            const md5 = urlMetadata?.queryParams?.md5;
            const pid = urlMetadata?.queryParams?.pid;
            if (pathSegment && pdfExtension && pii && md5 && pid) {
                const constructed = `/${pathSegment}/${pii}${pdfExtension}?md5=${md5}&pid=${pid}`;
                addCandidate(candidates, seen, constructed, pageUrl, "json_url_metadata");
            }
        } catch {
            // Ignore malformed embedded JSON and continue to other heuristics.
        }
    }

    const canonicalUrl = $('link[rel="canonical"]').attr("href");
    if (canonicalUrl) {
        try {
            const canonical = new URL(canonicalUrl, pageUrl);
            canonical.pathname = canonical.pathname.replace(/\/+$/, "") + "/pdfft";
            canonical.search = canonical.search ? `${canonical.search}&download=true` : "?download=true";
            addCandidate(candidates, seen, canonical.toString().replace(":5037", ""), pageUrl, "canonical_pdfft");
        } catch {
            // Ignore invalid canonical URLs.
        }
    }

    return candidates;
}

export function parseScienceDirectIntermediateRedirect(html: string, sourceUrl: string): string | null {
    const $ = cheerio.load(html);
    const refreshValue = $('meta[http-equiv="Refresh"], meta[http-equiv="refresh"]').attr("content");
    if (refreshValue) {
        const match = refreshValue.match(/\d+\s*;\s*url=(.+)$/i);
        if (match?.[1]) {
            return absolutizeUrl(match[1], sourceUrl) || null;
        }
    }

    const redirectHref = $("#redirect-message a").attr("href");
    if (redirectHref) {
        return absolutizeUrl(redirectHref, sourceUrl) || null;
    }

    if (sourceUrl.toLowerCase().includes(".pdf")) {
        return sourceUrl;
    }

    return null;
}

export function classifyPdfContent(buffer: Buffer, contentType?: string): PdfValidationResult {
    const header = buffer.subarray(0, 5).toString("ascii");
    const normalizedType = (contentType || "").toLowerCase();

    if (buffer.length === 0) {
        return {
            isPdf: false,
            header,
            contentType,
            reason: "empty_body"
        };
    }

    if (header.startsWith("%PDF")) {
        return {
            isPdf: true,
            header,
            contentType,
            reason: "pdf_magic_bytes"
        };
    }

    const prefix = buffer.subarray(0, 512).toString("utf-8").toLowerCase().replace(/\0/g, "");
    const looksLikeHtml = prefix.includes("<html")
        || prefix.includes("<!doctype html")
        || prefix.includes("<body")
        || prefix.includes("cf-browser")
        || prefix.includes("captcha")
        || prefix.includes("are you a robot");

    if (looksLikeHtml || normalizedType.includes("text/html")) {
        return {
            isPdf: false,
            header,
            contentType,
            reason: "html_or_challenge_page"
        };
    }

    if (normalizedType.includes("application/pdf")) {
        return {
            isPdf: false,
            header,
            contentType,
            reason: "pdf_content_type_without_magic_bytes"
        };
    }

    return {
        isPdf: false,
        header,
        contentType,
        reason: "missing_pdf_magic_bytes"
    };
}

export function extractElsevierMetadataSignal(payload: any, fallbackDoi: string): ElsevierMetadataSignal | null {
    const retrieval = payload?.["full-text-retrieval-response"];
    if (!retrieval || typeof retrieval !== "object") return null;

    const coredata = retrieval.coredata || {};
    const links = []
        .concat(Array.isArray(coredata.link) ? coredata.link : [])
        .concat(Array.isArray(retrieval.link) ? retrieval.link : []);

    const scidirLink = links.find((entry: any) => {
        const rel = String(entry?.["@rel"] || entry?.["@ref"] || "").toLowerCase();
        const href = String(entry?.["@href"] || "").toLowerCase();
        return rel.includes("scidir") || href.includes("sciencedirect.com");
    });

    const title = typeof coredata["dc:title"] === "string" ? normalizeWhitespace(coredata["dc:title"]) : undefined;
    const abstract = typeof coredata["dc:description"] === "string" ? normalizeWhitespace(coredata["dc:description"]) : undefined;
    const doi = typeof coredata["prism:doi"] === "string" ? coredata["prism:doi"] : fallbackDoi;

    return {
        doi,
        title,
        abstract,
        pii: typeof coredata.pii === "string" ? coredata.pii : undefined,
        eid: typeof coredata.eid === "string" ? coredata.eid : undefined,
        scidir: typeof scidirLink?.["@href"] === "string" ? scidirLink["@href"] : undefined,
        openaccess: coredata.openaccess !== undefined ? String(coredata.openaccess) : undefined,
        publisher: "Elsevier"
    };
}

export function benchmarkLogLine(doi: string, diagnostic: FetchAttemptDiagnostic): string {
    return JSON.stringify({
        kind: "fetch_benchmark",
        doi,
        ...diagnostic
    });
}
