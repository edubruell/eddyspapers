## Roadmap (eddy’s papers)

**Priority order (as of 2026-05-21):**
1. **Agentic search** at `agenticsearch.eduard-bruell.de` — design complete, build next. The cooler idea and clear next thing to ship. Full design in `agentic/` (start at `agentic/00_overview.md`; 12-phase plan in `agentic/05_roadmap.md`).
2. Bibliographic coupling (v0.4.1) — small follow-through on the MCP/citation work; can land alongside or after agentic.
3. **People search** using the `pers` data — interesting and worth doing, but **not a current priority**. Sequenced as the author-database track below (v0.5.x → v0.6.0). The Diogenes-meerkat at `econpeople.eduard-bruell.de` stays the destination once we get there.
4. Long-tail items (topic clustering, full-text, author graphs) — unchanged, post-people-search.

---

### v0.3.3 (DONE)
**Focus: quality of life**
- API defaults + ordering consistency
- Minor frontend adjustments from real usage
- Small performance wins

### v0.4.0 MCP + Agent Integration (DONE, but not advertised, needs updating of API endpoints)
**Focus:** machine-facing search
- Expose all stable API endpoints as MCP tools
- Tool schemas for: search, cite, cited-by, stats, versions, topics
- Deterministic search objects for agent reuse
- Integration targets:
  - OpenWebUI (ZEW)
- No UI changes required
- **Note:** this R MCP server will be retired and replaced by the Node-based MCP adapter inside the agentic project (see `agentic/01_design.md` §7 + `agentic/05_roadmap.md` Phase 11). Dual-run for a week, then delete `backend/R/mcp_server.R`.

### v0.4.1 (post-launch)
**Focus: bibliographic coupling**
- Add `bib_coupling` (precomputed)
- API: Top `n` similar-by-references papers
- Frontend: show in result expansion
- Useful for the agentic project too (`bib_coupling` is one of the tables the sandbox verbs query) but not a blocker for it.

### v0.4.5 Agentic Search (NEW — top priority)
**Focus:** hosted multi-turn lit-review service at `agenticsearch.eduard-bruell.de`
- TS orchestrator (Hono) + sandboxed R script execution + Astro/React chat UI + Node MCP server.
- Reproduces the `lit-search` Claude Code skill as a hosted service, callable from web *or* MCP.
- Detective-meerkat sibling branding to the existing semantic search app.
- Full design and 12-phase build plan in `agentic/`. Phase 5 is the cost-benchmark gate.
- Retires the old R MCP server (see v0.4.0 note).

### v0.5.0 (author database, phase 1) — *deprioritised, not blocked*
**Focus: author identities + manual curation**
- Preceeding work to get `pers` archive from RePEc is done! (Pers + what is there that is not in pers sounds good)
- Seed distinct author strings (Top5 + selected fields + manual list)
- Tables: `authors`, `author_name_variants`, `author_string_candidates`
- No scraping yet; no public author pages yet

### v0.5.1 (author database, phase 2)
**Focus: source discovery + human verification**
- tidyllm with claude/gemini webtools to find homepage/CV URLs
- Tables: `author_sources`, optional `author_raw_documents`
- Admin UI: accept/reject URLs, track confidence
- explicit handling for ORCID and Google Scholar URLs

### v0.5.2 (author database, phase 3)
**Focus: structured extraction + paper linkage**
- Claude Haiku JSON extraction (affiliation, fields, editorial roles, publications)
- Tables: `author_extractions`, `author_profiles`
- Link publications to internal `articles` (deterministic first, then semantic + review)
- `articles` gets helpers for non-indexed papers of these authors

### v0.6.0 (author frontend)
**Focus: public author browsing**
- `/authors/:id` profile + papers (linked to internal handles)
- Optional: “similar authors” (coauthor graph / overlap)
- Author Search (perhaps at econpeople.eduard-bruell.de)
  - The "meerkat with a paper" logo/maskot gets an old-style lamp in his hand instead of a paper and an climbs out of a Fass for this new site (It is a reference to Diogenes "Ich suche Menschen")

### v0.7.0 Corpus Intelligence
**Focus:** semantic structure of the literature
- Bibliographic vs semantic coupling explorer (separate view/site)
- Periodic clustering of paper embeddings (HDBSCAN or similar)
- Tables: `topics`, `topic_memberships`, `topic_centroids`
- Topic evolution over time (centroid by year)
- Lightweight LLM tags: method, data, identification (controlled vocab)
- API: topic-filtered search, related-literature endpoint

### v0.7.1 Author Graphs (Analytics Layer)
**Focus:** networks, not profiles
- Coauthor graph from internal citations + metadata
- Centrality and community measures (precomputed)
- Author–topic embeddings and field proximity
- Career trajectories (topic and journal movement)
- API: `/author/graph`, `/author/similar`, `/author/trajectory`

### v0.8.0 Full-Text Pipeline (Working Papers)
**Focus:** deep semantic querying
- Download WP PDFs where available
- Markdown conversion via `markitdown`
- Structure-aware chunking 
- Tables:  `fulltext_chunks`
- Separate embedding space for full text
- API: full-text semantic search (secondary frontend)

### v0.8.2 Hybrid Retrieval (Metadata + Full Text)
**Focus:** precision for LLM queries
- Hybrid ranking: abstract embeddings + full-text chunks
- Query routing (bibliographic vs conceptual vs methodological)
- Section-aware retrieval (“find identification strategy”)
- MCP tools optimized for long-form agent queries

### v0.9.0 Author Graphs (Public View)
**Focus:** exploration, not curation
- Author network visualization
- Topic overlap and proximity
- Coauthor communities
- Frontend: `/authors/:id/network`
- Clearly labeled heuristics; no hard claims


