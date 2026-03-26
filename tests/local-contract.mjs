/**
 * Local contract test for installation-agnostic GRaDOS paper APIs.
 * Usage: node tests/local-contract.mjs
 */
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const FIXTURE_DOI = '10.5555/grados.fixture';
const FIXTURE_SAFE_DOI = '10_5555_grados_fixture';
const FIXTURE_URI = `grados://papers/${FIXTURE_SAFE_DOI}`;

function createFixtureMarkdown() {
    return [
        '---',
        `doi: "${FIXTURE_DOI}"`,
        'title: "GRaDOS Fixture Paper"',
        'source: "Fixture Source"',
        'fetched_at: "2026-03-24T00:00:00.000Z"',
        '---',
        '',
        '# GRaDOS Fixture Paper',
        '',
        'Abstract paragraph one.',
        '',
        '## Introduction',
        '',
        'Introduction paragraph one.',
        '',
        'Introduction paragraph two.',
        '',
        '## Results',
        '',
        'Result paragraph one.',
        '',
        'Result paragraph two.',
        '',
        '## Discussion',
        '',
        'Discussion paragraph one.'
    ].join('\n');
}

async function run() {
    const tempDir = mkdtempSync(join(tmpdir(), 'grados-contract-'));
    const papersDir = join(tempDir, 'papers');
    const downloadsDir = join(tempDir, 'downloads');
    mkdirSync(papersDir, { recursive: true });
    mkdirSync(downloadsDir, { recursive: true });

    const configPath = join(tempDir, 'grados-config.json');
    writeFileSync(configPath, JSON.stringify({
        extract: {
            papersDirectory: './papers',
            downloadDirectory: './downloads'
        },
        search: {
            order: ['Crossref'],
            enabled: { Elsevier: false, Springer: false, WebOfScience: false, Crossref: true, PubMed: false }
        },
        apiKeys: {},
        academicEtiquetteEmail: 'fixture@example.edu'
    }, null, 2));

    writeFileSync(join(papersDir, `${FIXTURE_SAFE_DOI}.md`), createFixtureMarkdown());

    const transport = new StdioClientTransport({
        command: 'node',
        args: ['dist/index.js', '--config', configPath],
        cwd: process.cwd()
    });
    const client = new Client({ name: 'local-contract-test', version: '1.0.0' });

    try {
        await client.connect(transport);

        const { tools } = await client.listTools();
        assert.equal(tools.length, 5, 'expected five tools');
        assert(tools.some((tool) => tool.name === 'read_saved_paper'), 'read_saved_paper should be listed');

        const searchTool = tools.find((tool) => tool.name === 'search_academic_papers');
        assert.equal(searchTool?.inputSchema?.properties?.limit?.default, 15, 'search limit default should be 15');
        assert.equal(searchTool?.inputSchema?.properties?.continuation_token?.type, 'string', 'search continuation token should be exposed in the tool schema');
        assert.equal(searchTool?.outputSchema?.properties?.has_more?.type, 'boolean', 'search output should expose has_more');
        assert.equal(searchTool?.outputSchema?.properties?.next_continuation_token?.type, 'string', 'search output should expose next_continuation_token');

        const { resources } = await client.listResources();
        assert(resources.some((resource) => resource.uri === 'grados://papers/index'), 'papers index resource should be listed');

        const { resourceTemplates } = await client.listResourceTemplates();
        assert(resourceTemplates.some((template) => template.uriTemplate === 'grados://papers/{safe_doi}'), 'paper resource template should be listed');

        const aboutResource = await client.readResource({ uri: 'grados://about' });
        const about = JSON.parse(aboutResource.contents[0].text);
        assert(about.tools.some((tool) => tool.name === 'read_saved_paper'), 'about resource should include read_saved_paper');

        const toolsResource = await client.readResource({ uri: 'grados://tools' });
        const toolsMirror = JSON.parse(toolsResource.contents[0].text);
        const mirroredSearchTool = toolsMirror.find((tool) => tool.name === 'search_academic_papers');
        assert.equal(mirroredSearchTool?.inputSchema?.properties?.limit?.default, 15, 'tools resource should mirror search default');
        assert.equal(mirroredSearchTool?.inputSchema?.properties?.continuation_token?.type, 'string', 'tools resource should mirror continuation_token input');
        assert.equal(mirroredSearchTool?.outputSchema?.properties?.has_more?.type, 'boolean', 'tools resource should mirror has_more output');

        const paperIndexResource = await client.readResource({ uri: 'grados://papers/index' });
        const paperIndex = JSON.parse(paperIndexResource.contents[0].text);
        assert.equal(paperIndex.length, 1, 'papers index should list one fixture paper');
        assert.equal(paperIndex[0].canonical_uri, FIXTURE_URI, 'papers index should expose canonical URI');

        const safeDoiRead = await client.callTool({
            name: 'read_saved_paper',
            arguments: { safe_doi: FIXTURE_SAFE_DOI, max_paragraphs: 2 }
        });
        assert.equal(safeDoiRead.structuredContent?.kind, 'paper_read_result');
        assert.equal(safeDoiRead.structuredContent?.canonical_uri, FIXTURE_URI);
        assert(safeDoiRead.content.some((item) => item.type === 'resource_link'), 'read_saved_paper should include resource link');

        const uriRead = await client.callTool({
            name: 'read_saved_paper',
            arguments: { uri: FIXTURE_URI, section_query: 'Results', max_paragraphs: 2 }
        });
        assert.equal(uriRead.structuredContent?.kind, 'paper_read_result');
        assert.equal(uriRead.structuredContent?.start_paragraph >= 0, true);
        assert(uriRead.structuredContent?.content_text.includes('Result paragraph one.'), 'section query should read from results section');

        const paperResource = await client.readResource({ uri: FIXTURE_URI });
        assert(paperResource.contents[0].text.includes('GRaDOS Fixture Paper'), 'paper resource should return full markdown');

        console.log('Local contract test passed.');
    } finally {
        await client.close().catch(() => {});
        rmSync(tempDir, { recursive: true, force: true });
    }
}

run().catch((error) => {
    console.error('Local contract test failed:', error);
    process.exit(1);
});
