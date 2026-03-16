import axios from 'axios';
import fs from 'fs';
import path from 'path';

async function getWorkingSciHubMirror(fallback: string): Promise<string> {
    const mirror = fallback;
    try {
        await axios.get(mirror, { timeout: 3000 });
        return mirror;
    } catch(e) {
        console.log(`Default Sci-Hub mirror ${mirror} seems dead. Falling back...`);
        return "https://sci-hub.ru"; 
    }
}

async function fetchFromSciHub(doi: string): Promise<Buffer | null> {
    try {
        const mirrorUrl = "https://sci-hub.se";
        
        const activeMirror = await getWorkingSciHubMirror(mirrorUrl);
        console.log(`Attempting Sci-Hub via mirror: ${activeMirror} for DOI: ${doi}...`);
        
        const res = await axios.get(`${activeMirror}/${doi}`, {
            headers: {
                 "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
            }
        });
        
        const html = res.data;
        const iframeMatch = html.match(/<iframe.*?src=["'](.*?)["']/i) || html.match(/<embed.*?src=["'](.*?)["']/i);
        
        if (iframeMatch && iframeMatch[1]) {
            let pdfUrl = iframeMatch[1];
            if (pdfUrl.startsWith('//')) {
                pdfUrl = 'https:' + pdfUrl;
            } else if (pdfUrl.startsWith('/')) {
                pdfUrl = activeMirror + pdfUrl;
            }
            
            console.log(`Sci-Hub bypassed paywall! Downloading PDF from: ${pdfUrl}`);
            const pdfRes = await axios.get(pdfUrl, { responseType: 'arraybuffer' });
            return Buffer.from(pdfRes.data);
        }
    } catch(e: any) {
        console.log(`Sci-Hub fetch failed (${e.message}).`);
    }
    return null;
}

fetchFromSciHub("10.1038/s41586-020-2649-2").then(buf => {
    if (buf) {
        console.log("PDF buffer size:", buf.length);
    } else {
        console.log("Failed to get buffer");
    }
});
