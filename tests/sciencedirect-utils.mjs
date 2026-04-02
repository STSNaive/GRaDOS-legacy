import assert from "node:assert/strict";
import {
    classifyPdfContent,
    detectBotChallenge,
    extractElsevierMetadataSignal,
    extractScienceDirectPdfCandidates,
    parseScienceDirectIntermediateRedirect
} from "../dist/publisher-utils.js";

function candidateUrls(candidates) {
    return candidates.map((candidate) => candidate.url);
}

const scienceDirectUrl = "https://www.sciencedirect.com/science/article/pii/S0263822321006401?via%3Dihub";

{
    const html = `
        <html>
            <head>
                <meta name="citation_pdf_url" content="/science/article/pii/S0263822321006401/pdfft?download=true&md5=aaa&pid=1-s2.0-S0263822321006401-main.pdf">
                <link rel="canonical" href="https://www.sciencedirect.com/science/article/pii/S0263822321006401">
            </head>
            <body>
                <a id="pdfLink" href="/science/article/pii/S0263822321006401/pdfft?download=true&md5=bbb&pid=1-s2.0-S0263822321006401-main.pdf">PDF</a>
                <div class="PdfEmbed">
                    <object data="/science/article/pii/S0263822321006401/pdfft?download=true&md5=ccc&pid=1-s2.0-S0263822321006401-main.pdf"></object>
                </div>
                <div class="PdfDropDownMenu">
                    <a href="/science/article/pii/S0263822321006401/pdfft?download=true&md5=ddd&pid=1-s2.0-S0263822321006401-main.pdf">Download PDF</a>
                </div>
            </body>
        </html>
    `;

    const candidates = extractScienceDirectPdfCandidates(html, scienceDirectUrl);
    const urls = candidateUrls(candidates);
    assert.equal(urls.length, 5, "should extract multiple unique ScienceDirect PDF candidates");
    assert(urls.some((url) => url.includes("md5=aaa")), "should include citation_pdf_url candidate");
    assert(urls.some((url) => url.includes("md5=bbb")), "should include #pdfLink candidate");
    assert(urls.some((url) => url.includes("md5=ccc")), "should include embedded object candidate");
    assert(urls.some((url) => url.includes("md5=ddd")), "should include dropdown menu candidate");
    assert(urls.some((url) => url.includes("/pdfft?download=true")), "should include canonical pdfft fallback");
}

{
    const html = `
        <html>
            <body>
                <script type="application/json">
                    {
                        "article": {
                            "pdfDownload": {
                                "urlMetadata": {
                                    "path": "science/article/pii",
                                    "pdfExtension": "/pdf",
                                    "pii": "S0263822321006401",
                                    "queryParams": {
                                        "md5": "xyz",
                                        "pid": "1-s2.0-S0263822321006401-main.pdf"
                                    }
                                }
                            }
                        }
                    }
                </script>
            </body>
        </html>
    `;
    const candidates = extractScienceDirectPdfCandidates(html, scienceDirectUrl);
    assert.equal(candidates.length, 1, "JSON metadata should yield a single candidate");
    assert(candidates[0].url.includes("md5=xyz"), "JSON metadata candidate should include md5");
    assert(candidates[0].url.includes("pid=1-s2.0-S0263822321006401-main.pdf"), "JSON metadata candidate should include pid");
}

{
    const html = `
        <html>
            <head>
                <meta http-equiv="Refresh" content="0;URL=/science/article/pii/S0263822321006401/pdfft?download=true&md5=redirect&pid=1-s2.0-main.pdf">
            </head>
        </html>
    `;
    const redirect = parseScienceDirectIntermediateRedirect(html, "https://www.sciencedirect.com/science/article/pii/S0263822321006401/pdfft");
    assert.equal(
        redirect,
        "https://www.sciencedirect.com/science/article/pii/S0263822321006401/pdfft?download=true&md5=redirect&pid=1-s2.0-main.pdf"
    );
}

{
    const html = `
        <html>
            <body>
                <div id="redirect-message">
                    <a href="/science/article/pii/S0263822321006401/pdfft?download=true&md5=follow&pid=1-s2.0-main.pdf">Continue</a>
                </div>
            </body>
        </html>
    `;
    const redirect = parseScienceDirectIntermediateRedirect(html, scienceDirectUrl);
    assert.equal(
        redirect,
        "https://www.sciencedirect.com/science/article/pii/S0263822321006401/pdfft?download=true&md5=follow&pid=1-s2.0-main.pdf"
    );
}

{
    const validation = classifyPdfContent(Buffer.from("%PDF-1.7\nhello", "utf-8"), "application/pdf");
    assert.equal(validation.isPdf, true, "real PDF magic bytes should validate");
}

{
    const validation = classifyPdfContent(Buffer.from("<html><title>Are you a robot?</title><body>captcha</body></html>", "utf-8"), "text/html");
    assert.equal(validation.isPdf, false, "HTML challenge page should not validate as PDF");
    assert.equal(validation.reason, "html_or_challenge_page");
}

{
    const signal = extractElsevierMetadataSignal({
        "full-text-retrieval-response": {
            coredata: {
                "prism:doi": "10.1016/j.compstruct.2020.112569",
                "dc:title": "Example Elsevier Article",
                "dc:description": "A metadata-only abstract.",
                pii: "S026382232030569X",
                eid: "2-s2.0-85099999999",
                openaccess: 0,
                link: [
                    { "@rel": "scidir", "@href": "https://www.sciencedirect.com/science/article/pii/S026382232030569X" }
                ]
            }
        }
    }, "fallback-doi");

    assert.equal(signal?.doi, "10.1016/j.compstruct.2020.112569");
    assert.equal(signal?.openaccess, "0");
    assert.equal(signal?.scidir, "https://www.sciencedirect.com/science/article/pii/S026382232030569X");
}

{
    assert.equal(detectBotChallenge("请稍候…", "<html><body>Are you a robot?</body></html>", scienceDirectUrl), true);
    assert.equal(detectBotChallenge("Article page", "<html><body>normal article</body></html>", scienceDirectUrl), false);
}

console.log("ScienceDirect utility tests passed.");
