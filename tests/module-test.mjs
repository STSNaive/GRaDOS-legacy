/**
 * Module-level test — tests each search source and fetch strategy individually.
 * Usage: node tests/module-test.mjs
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';

const QUERY = 'elastic metamaterial';
const CONFIG_PATH = join(process.cwd(), 'grados-config.json');
const CONFIG_BACKUP = join(process.cwd(), 'grados-config.json.bak');

if (!existsSync(CONFIG_PATH)) {
    console.log('Skipping module-test: grados-config.json not found in repository root.');
    process.exit(0);
}

// Save original config
const originalConfig = readFileSync(CONFIG_PATH, 'utf8');
writeFileSync(CONFIG_BACKUP, originalConfig);

function setConfig(patch) {
    const cfg = JSON.parse(originalConfig);
    patch(cfg);
    writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 4));
}

function restoreConfig() {
    writeFileSync(CONFIG_PATH, originalConfig);
}

async function createClient() {
    const transport = new StdioClientTransport({
        command: 'node', args: ['dist/index.js'], cwd: process.cwd()
    });
    const client = new Client({ name: 'module-test', version: '1.0.0' });
    await client.connect(transport);
    return client;
}

const results = {};

function getSummaryInfo(result) {
    const structured = result.structuredContent;
    const content = result.content || [];
    return {
        ok: structured?.kind === 'paper_saved_summary' && content.some(item => item.type === 'resource_link'),
        kind: structured?.kind,
        uri: structured?.canonical_uri,
        relativePath: structured?.relative_path,
        previewLength: structured?.preview_excerpt?.length || 0
    };
}

// ========== PART 1: Test each search source individually ==========
const searchSources = ['Crossref', 'PubMed', 'Springer', 'WebOfScience', 'Elsevier'];

for (const source of searchSources) {
    console.log(`\n--- Search: ${source} ---`);
    // Enable only this source
    setConfig(cfg => {
        cfg.search.order = [source];
        cfg.search.enabled = {};
        for (const s of searchSources) cfg.search.enabled[s] = (s === source);
    });

    let client;
    try {
        client = await createClient();
        const r = await client.callTool({
            name: 'search_academic_papers',
            arguments: { query: QUERY, limit: 3 }
        });
        const text = r.content?.[0]?.text || '';
        const doiRegex = /\*\*DOI:\*\*\s*(.+)/g;
        const dois = [];
        let m;
        while ((m = doiRegex.exec(text)) !== null) dois.push(m[1].trim());

        const titleRegex = /### \d+\. (.+)/g;
        const titles = [];
        while ((m = titleRegex.exec(text)) !== null) titles.push(m[1].trim());

        const isError = r.isError || false;
        results[`search_${source}`] = {
            ok: !isError && dois.length > 0,
            count: dois.length,
            dois: dois.slice(0, 2),
            titles: titles.slice(0, 2),
            error: isError ? text.substring(0, 150) : null
        };
        console.log(`  Results: ${dois.length}, DOIs: ${dois.slice(0, 2).join(', ')}`);
        console.log(`  Titles: ${titles.slice(0, 2).join(' | ')}`);
    } catch (e) {
        results[`search_${source}`] = { ok: false, error: e.message.substring(0, 150) };
        console.log(`  ERROR: ${e.message.substring(0, 150)}`);
    } finally {
        if (client) await client.close().catch(() => {});
    }
}

// ========== PART 2: Test fetch strategies with known DOIs ==========
// Use a Nature OA paper (confirmed working from previous test)
const testDoi = '10.1038/s41598-025-29656-1';

// Test 2a: Sci-Hub only
console.log(`\n--- Fetch: Sci-Hub only (DOI: ${testDoi}) ---`);
setConfig(cfg => {
    // Restore search to default
    cfg.search.order = ['Elsevier', 'Springer', 'WebOfScience', 'Crossref', 'PubMed'];
    cfg.search.enabled = { Elsevier: true, Springer: true, WebOfScience: true, Crossref: true, PubMed: true };
    // Fetch: Sci-Hub only
    cfg.extract.fetchStrategy.order = ['SciHub'];
    cfg.extract.fetchStrategy.enabled = { TDM: false, OA: false, SciHub: true, Headless: false };
});

{
    let client;
    try {
        client = await createClient();
        const r = await client.callTool({
            name: 'extract_paper_full_text',
            arguments: { doi: testDoi }
        });
        const text = r.content?.[0]?.text || '';
        const isError = r.isError || false;
        const summaryInfo = getSummaryInfo(r);
        results['fetch_SciHub'] = {
            ok: !isError && summaryInfo.ok,
            length: text.length,
            isError,
            preview: text.substring(0, 150),
            kind: summaryInfo.kind,
            uri: summaryInfo.uri,
            relativePath: summaryInfo.relativePath
        };
        console.log(`  isError: ${isError}, kind: ${summaryInfo.kind || '(none)'}, uri: ${summaryInfo.uri || '(none)'}`);
        if (text.length > 0) console.log(`  Preview: ${text.substring(0, 120)}...`);
    } catch (e) {
        results['fetch_SciHub'] = { ok: false, error: e.message.substring(0, 150) };
        console.log(`  ERROR: ${e.message.substring(0, 150)}`);
    } finally {
        if (client) await client.close().catch(() => {});
    }
}

// Test 2b: Springer OA TDM (for a Springer DOI)
const springerDoi = '10.1038/s41598-025-29656-1'; // Nature Scientific Reports = Springer
console.log(`\n--- Fetch: TDM only - Springer OA (DOI: ${springerDoi}) ---`);
setConfig(cfg => {
    cfg.extract.fetchStrategy.order = ['TDM'];
    cfg.extract.fetchStrategy.enabled = { TDM: true, OA: false, SciHub: false, Headless: false };
});

{
    let client;
    try {
        client = await createClient();
        const r = await client.callTool({
            name: 'extract_paper_full_text',
            arguments: { doi: springerDoi }
        });
        const text = r.content?.[0]?.text || '';
        const isError = r.isError || false;
        const summaryInfo = getSummaryInfo(r);
        results['fetch_TDM_Springer'] = {
            ok: !isError && summaryInfo.ok,
            length: text.length,
            isError,
            preview: text.substring(0, 150),
            kind: summaryInfo.kind,
            uri: summaryInfo.uri,
            relativePath: summaryInfo.relativePath
        };
        console.log(`  isError: ${isError}, kind: ${summaryInfo.kind || '(none)'}, uri: ${summaryInfo.uri || '(none)'}`);
        if (text.length > 0) console.log(`  Preview: ${text.substring(0, 120)}...`);
    } catch (e) {
        results['fetch_TDM_Springer'] = { ok: false, error: e.message.substring(0, 150) };
        console.log(`  ERROR: ${e.message.substring(0, 150)}`);
    } finally {
        if (client) await client.close().catch(() => {});
    }
}

// Test 2c: OA-only with fallback locations (arXiv paper)
const arxivDoi = '10.1016/j.jmps.2019.103764'; // has arXiv mirror
console.log(`\n--- Fetch: OA only with location fallback (DOI: ${arxivDoi}) ---`);
setConfig(cfg => {
    cfg.extract.fetchStrategy.order = ['OA'];
    cfg.extract.fetchStrategy.enabled = { TDM: false, OA: true, SciHub: false, Headless: false };
});

{
    let client;
    try {
        client = await createClient();
        const r = await client.callTool({
            name: 'extract_paper_full_text',
            arguments: { doi: arxivDoi, expected_title: 'Elastic metamaterials' }
        });
        const text = r.content?.[0]?.text || '';
        const isError = r.isError || false;
        const summaryInfo = getSummaryInfo(r);
        results['fetch_OA_arXiv'] = {
            ok: !isError && summaryInfo.ok,
            length: text.length,
            isError,
            preview: text.substring(0, 150),
            kind: summaryInfo.kind,
            uri: summaryInfo.uri,
            relativePath: summaryInfo.relativePath
        };
        console.log(`  isError: ${isError}, kind: ${summaryInfo.kind || '(none)'}, uri: ${summaryInfo.uri || '(none)'}`);
        if (text.length > 0) console.log(`  Preview: ${text.substring(0, 120)}...`);
    } catch (e) {
        results['fetch_OA_arXiv'] = { ok: false, error: e.message.substring(0, 150) };
        console.log(`  ERROR: ${e.message.substring(0, 150)}`);
    } finally {
        if (client) await client.close().catch(() => {});
    }
}

// ========== PART 3: Restore config and print summary ==========
restoreConfig();

console.log('\n\n========== MODULE TEST SUMMARY ==========\n');
for (const [key, val] of Object.entries(results)) {
    const status = val.ok ? '✅' : '❌';
    let detail = '';
    if (key.startsWith('search_')) {
        detail = val.ok ? `${val.count} results` : (val.error || 'no results');
    } else {
        detail = val.ok ? `${val.length} chars` : (val.error || `isError=${val.isError}, ${val.length} chars`);
    }
    console.log(`  ${status} ${key}: ${detail}`);
}
console.log();
