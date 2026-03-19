# GRaDOS Resources - Revised Phase 2 and Phase 3 Plan

This document updates the original future-resource plan after checking the current implementation in `src/index.ts`.

Phase 1 is already in place:

- `grados://about`
- `grados://status`
- `grados://tools`
- `resources/templates/list` handler returning `[]`

The next step should optimize for useful runtime snapshots, not real-time streaming.

## Real-time necessity assessment

The planned Phase 2 resources are mainly for discoverability, debugging, and cache inspection. None of them currently justify subscriptions, filesystem watchers, or push updates.

| Item | Real-time need | Decision | Notes |
| --- | --- | --- | --- |
| `grados://config` | Low | Defer as a standalone resource | `grados://status` already exposes most of the useful sanitized config surface. |
| `grados://papers/index` | Low | Keep | Generate on read, or invalidate a short TTL cache after successful extraction. |
| `grados://failures` | Medium recency, low true real-time | Keep | Use a small in-memory ring buffer; clients can read when needed. |
| `grados://paper/{safe_doi}` | Low | Keep for Phase 3 | Read on demand only; no background indexing beyond existing paper writes. |
| `grados://query/{topic}` | Low | Defer or make optional | Overlaps with `mcp-local-rag` local search; add only if a simple built-in cache search is still needed. |

## Design rule

Phase 2 should be snapshot-based:

- No real-time subscriptions
- No filesystem watchers
- No background polling
- Compute small status and config views on read
- For heavier inventory reads, use lazy refresh or short TTL caching
- Prefer extending an existing resource over adding a near-duplicate one

## Revised Phase 2: Operational visibility

### 1. Expand `grados://status`

**Purpose:** Keep one primary "what is the server's current state?" endpoint.

**Add or emphasize:**

- Sanitized search source enabled/disabled map
- Current search order
- Current fetch strategy order
- Current parsing order
- Directories and existence checks
- API key configured/not configured flags
- `academicEtiquetteEmail`
- Optional `lastConfigLoadTime` if config reload is added later

**Why here instead of `grados://config`:**

- Lower surface area
- Less duplication
- Better discoverability for clients that only read one diagnostic resource

### 2. Add `grados://papers/index`

**Purpose:** List cached paper outputs already available locally.

**Content per entry:**

- DOI
- Title
- Source
- Fetched timestamp
- Markdown path
- `pdfExists`

**Implementation notes:**

- Parse YAML front matter from `papersDirectory`
- Build on read
- Optional: short TTL cache (for example 5 to 30 seconds)
- Better: invalidate cache immediately after a successful extraction writes a new paper

### 3. Add `grados://failures`

**Purpose:** Show recent structured extraction failures for debugging.

**Content per entry:**

- DOI
- Title if known
- Failed stage
- Error summary
- Timestamp
- Suggested retry route

**Implementation notes:**

- Use an in-memory ring buffer (for example 50 items)
- Append entries at fetch/parser failure points
- Expose only recent runtime failures; no persistence required for now

## Revised Phase 3: Content access

### `grados://paper/{safe_doi}`

**Purpose:** Read cached paper metadata and a text preview or full markdown body.

**Content:**

- DOI
- Title
- Local path
- Extraction source
- Section list
- Preview or full markdown

**Implementation notes:**

- Use `ResourceTemplate`
- Default to preview or truncated content to avoid buffer issues
- Add full content only if client behavior is safe

### Optional later: `grados://doi/{doi}`

**Purpose:** Convenience alias for DOI lookup.

### Deferred: `grados://query/{topic}`

**Reason:** It likely overlaps with `mcp-local-rag.query_documents`; only add it if a lightweight built-in cache search is still useful for clients that cannot use the companion MCP.

## Prerequisites

- Front-matter parser helper for cached papers
- Recent failure recorder hook in the extraction pipeline
- Safe DOI encoder/decoder for template URIs
- Resource read tests for `status`, `papers/index`, and `failures`
- Keep `resources/templates/list` implemented even if the template list is empty

## Execution order

1. Enrich `grados://status` instead of adding `grados://config`
2. Implement `grados://papers/index`
3. Implement `grados://failures`
4. Add `grados://paper/{safe_doi}` template
5. Revisit `grados://doi/{doi}` and `grados://query/{topic}` only if client demand appears

## Bottom line

Phase 2 does not need true real-time behavior. The right tradeoff is accurate read-time snapshots with lightweight invalidation, keeping implementation simple while still making GRaDOS easier to inspect and debug from resource-oriented clients.
