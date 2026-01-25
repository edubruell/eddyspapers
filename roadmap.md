## Roadmap (eddy’s papers)

### v0.3.3 (early post-launch - current)
**Focus: quality of life**
- API defaults + ordering consistency
- Minor frontend adjustments from real usage
- Small performance wins

### v0.4.0 MCP + Agent Integration
**Focus:** machine-facing search
- Expose all stable API endpoints as MCP tools
- Tool schemas for: search, cite, cited-by, stats, versions, topics
- Deterministic search objects for agent reuse
- Integration targets:
  - OpenWebUI (ZEW)
  - shinychat “deep research” mode
- No UI changes required

### v0.4.1 (post-launch)
**Focus: bibliographic coupling**
- Add `bib_coupling` (precomputed)
- API: Top `n` similar-by-references papers
- Frontend: show in result expansion

### v0.5.0 (author database, phase 1)
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
- Author Search

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


