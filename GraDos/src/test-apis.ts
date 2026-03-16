import axios from "axios";
import * as fs from "fs";
import * as path from "path";

async function testKeys() {
    console.log("Loading config...");
    const configPath = path.join(process.cwd(), "mcp-config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    const keys = config.apiKeys;
    const query = "machine learning";

    console.log("\n==============================");
    console.log("1. Testing Elsevier (Scopus) API");
    try {
        const response = await axios.get("https://api.elsevier.com/content/search/scopus", {
            params: { query: query, count: 2 },
            headers: { "X-ELS-APIKey": keys.ELSEVIER_API_KEY, "Accept": "application/json" }
        });
        const count = response.data?.["search-results"]?.["opensearch:totalResults"];
        console.log(`✅ Elsevier API Success! Found ${count} total results for '${query}'.`);
    } catch (e: any) {
        console.log(`❌ Elsevier API Failed: ${e.response?.status} - ${e.response?.statusText}`);
        if(e.response?.data) console.log(JSON.stringify(e.response.data));
    }

    console.log("\n==============================");
    console.log("2. Testing Web of Science API");
    try {
        const response = await axios.get("https://api.clarivate.com/apis/wos-starter/v1/documents", {
            params: { q: `TS=(${query})`, limit: 2 },
            headers: { "X-ApiKey": keys.WOS_API_KEY }
        });
        const recs = response.data?.hits?.length || 0;
        const total = response.data?.metadata?.total || 0;
        console.log(`✅ Web of Science API Success! Fetched ${recs} records out of ${total} total.`);
    } catch (e: any) {
        console.log(`❌ Web of Science API Failed: ${e.response?.status} - ${e.response?.statusText}`);
        if(e.response?.data) console.log(JSON.stringify(e.response.data));
        else console.log(e.message);
    }

    console.log("\n==============================");
    console.log("3. Testing Springer Meta API");
    try {
        const response = await axios.get("https://api.springernature.com/meta/v2/json", {
            params: { q: query, p: 2, api_key: keys.SPRINGER_meta_API_KEY }
        });
        const total = response.data?.result?.[0]?.total || 0;
        console.log(`✅ Springer API Success! Found ${total} total results.`);
    } catch (e: any) {
        console.log(`❌ Springer API Failed: ${e.response?.status} - ${e.response?.statusText}`);
        if(e.response?.data) console.log(JSON.stringify(e.response.data));
    }
    console.log("\n==============================");
}

testKeys();
