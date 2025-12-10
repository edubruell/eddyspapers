# Semantic Economics Paper Search Engine - Status and Plan

## Project Overview

This is a semantic economics paper search engine that:
- Syncs academic papers from RePEc archives
- Parses RDF/ReDIF metadata files
- Generates semantic embeddings using Ollama (via tidyllm)
- Stores data in a DuckDB database with vector search (VSS extension)
- Provides a Plumber REST API for search queries

## Current State (as of 2025-12-09)

### Existing Structure
- `/backend` folder: Started package refactor
  - `DESCRIPTION`: Package metadata (eddyspapersbackend)
  - `R/config.R`: Configuration functions
  - `R/folders.R`: Folder reference factory
  - `R/sync.R`: RePEc RSync synchrosnisation
  - `R/parse.R`: RDF file parsing using Perl backend
  - `R/database.R`: Embedding and database operations
  - `NAMESPACE`: Package exports

## Design Layout

### 1. Backend Package Structure (`/backend`)

The backend package should contain:

**Core Functions**:
- RePEc sync utilities 
- RDF parsing utilities 
- Embedding generation 
- Database utilities

**Plumber API**:
- Search endpoint with semantic similarity
- Stats endpoints (journals, categories, total count, last updated)
- Database connection pooling
- Filter capabilities (year, journal, category, title/author keywords)
- Save endpoint (saves a search and its hash to the database)
- Search retrieve end (get a search with its inputs and outputs from the save table)

**Package Structure**:
```
backend/
├── DESCRIPTION
├── NAMESPACE
├── R/
│   ├── config.R         
│   ├── folders.R        
│   ├── sync.R           
│   ├── parse.R          
│   ├── embed.R          
│   ├── database.R       
│   └── api.R            
├── inst/
│   └── plumber/
│       └── api.R        
└── man/                 
```

### 2. Main Folder Scripts

The main project folder should have lightweight scripts that:
- Load the backend package
- Configure folder paths
- Invoke package functions

### 3. Frontend Structure (`/frontend`)

The frontend is a minimal prototype built with Astro and React components. It presents a two-phase UI:
- Landing state: centered logo (smaller) and wider search box.
- Results state: left sidebar with logo + search controls; right pane with results.

Key components (React):
- `SearchApp.jsx`: top-level state and layout; orchestrates search.
- `SearchPanel.jsx`: query textarea, category pills, min-year, search button.
- `CategoryPills.jsx`: selectable journal category chips.
- `Results.jsx`: renders results only after a search was triggered.
- `ResultCard.jsx`: individual paper card with copy-to-clipboard BibTeX and expand/collapse abstract.
- `SearchBox.jsx`: autosizing textarea input.

Astro layout:
- `src/layouts/AppLayout.astro`: global page layout and styles.

API client:
- `src/lib/api.js`: posts to the R Plumber backend at `http://127.0.0.1:8000/search` and implements saved searchers, database update data retrieval and other API features. 

## Technical Details

### Configuration
- Folder structure:
  - `data/RePEc/`: Downloaded RePEc archives
  - `data/rds_archivep/`: Parsed RDF data (RDS files)
  - `data/pqt/`: Parquet exports (optional)
  - `data/db/`: DuckDB database
  - `data/journals.csv`: Journal metadata

### Dependencies
- **Data Processing**: tidyverse, here, fs
- **Database**: DuckDB, pool, DBI
- **Embeddings**: tidyllm (Ollama integration)
- **API**: plumber
- **Utilities**: rprojroot, withr, arrow, jsonlite

### Key External Requirements
- Perl with ReDIF-perl modules (for parsing)
- Ollama with mxbai-embed-large model (for embeddings)
- rsync (for RePEc synchronization)

## Implementation Plan

### Phase 1: Complete Backend Package ✅ DONE
- [x] Set up package structure
- [x] Migrate config and folder utilities
- [x] Migrate sync functions
- [x] Migrate parse functions
- [x] Migrate embedding functions
- [x] Migrate database utilities
- [x] Create Plumber API wrapper
- [x] Document all functions with roxygen2
- [x] Update NAMESPACE with all exports
- [x] Add missing dependencies to DESCRIPTION

### Phase 2: Create Main Scripts ✅ DONE
- [x] Create `run_api.R` for production API
- [x] Create `update_repec.R` for cron jobs
- [x] Update `claude.md`

### Phase 3: Frontend Progress
- [x] Category pills wired to query filter
- [x] Results pane shown only after first search
- [x] Landing layout: smaller logo, wider box; transitions to sidebar when searching
- [x] Logo displayed above search panel with matching width
- [x] Search button right-aligned
- [x] Result card actions right-aligned with icons (BibTeX copy, More/Less)
- [x] Persist/search history and shareable URLs
- [x] Saved searches in the frontend
- [x] Visual polish and responsive refinements

### Phase 4: Citation Integration (IN PROGRESS)

**Goal:** Integrate RePEc citation data (iscited.txt) into backend with three-table design for performance.

#### Citation Architecture

**Three-Table Design:**

1. **`cit_all`** - Full citation graph (all edges from iscited.txt)
   - Columns: `citing VARCHAR`, `cited VARCHAR`
   - Indices: on both citing and cited
   - Purpose: Complete citation counts, includes papers outside our DB
   - Size: ~10M rows, ~150MB

2. **`cit_internal`** - Internal citation graph (both ends in our articles DB)
   - Columns: `citing VARCHAR`, `cited VARCHAR`
   - Indices: on both citing and cited
   - Purpose: Network analysis, metadata-rich queries
   - Size: ~1M rows, ~20MB
   - Derived from `cit_all` filtered to our corpus

3. **`handle_stats`** - Precomputed citation statistics (FUTURE)
   - Columns: `handle`, `total_citations`, `internal_citations`, `total_references`, 
     `pagerank`, `h_index`, `top_citing_journals`, `citations_by_year`, etc.
   - Purpose: Fast runtime queries, no joins needed
   - Updated during sync pipeline, not at query time
   - Enables advanced metrics: PageRank, H-index, citation velocity, co-citation clusters

#### Implementation Status

**Phase 4a: Citation Tables** ✅ DONE
- [x] Sync function: `sync_repec_iscited()` in `sync.R`
- [x] Streaming parser: `parse_iscited_streaming()` in `database.R`
- [x] Graph builder: `build_internal_citation_graph()` in `database.R`
- [x] Table init: `init_citations_tables()` in `database.R`
- [x] Update dump/restore functions for `cit_all` and `cit_internal`
- [x] API functions: `get_citing_papers()`, `get_cited_papers()`, `get_citation_counts()` in `api.R`
- [x] Plumber endpoints: `/cites`, `/citedby`, `/citationcounts` in `inst/plumber/api.R`
- [x] Update `update_repec.R` pipeline
- [x] Add R.utils dependency to DESCRIPTION
- [x] Update NAMESPACE with all exports

**Phase 4b: Precomputed Stats** (Future)
- [ ] Design `handle_stats` table schema
- [ ] Implement graph algorithms (PageRank, H-index, betweenness)
- [ ] Implement `compute_handle_stats()` batch processing
- [ ] API function: `get_handle_stats()` in `api.R`
- [ ] Plumber endpoint: `/handlestats` in `inst/plumber/api.R`
- [ ] Include in dump/restore cycle

**Phase 4c: Frontend Integration** (Future)
- [ ] Result card "More" expansion for versions (backend `/versions` exists)
- [ ] Result card "More" expansion shows citation counts
- [ ] Display: "Cited by X papers (Y in database)"
- [ ] List citing/cited papers with metadata
- [ ] Show precomputed stats badges (PageRank percentile, H-index, etc.)

#### Update Pipeline (with citations)

```r
# update_repec.R order:
1. Sync journals (rsync)
2. Parse RDF files
3. Embed & populate articles table
4. Write version links
5. Sync iscited.txt            # NEW
6. Parse & populate cit_all     # NEW
7. Build cit_internal          # NEW
8. Compute handle_stats        # FUTURE (Phase 4b)
9. Dump to parquet
```

#### API Endpoints

**Implemented:**
- `GET /versions?handle=...` - Related paper versions

**Phase 4a (In Progress):**
- `GET /cites?handle=...&limit=50` - Papers cited by this handle
- `GET /citedby?handle=...&limit=50` - Papers citing this handle

**Phase 4b (Future):**
- `GET /handlestats?handle=...` - Precomputed citation statistics


### Main Scripts to work with the packaged backend
- **`run_api.R`**: Production API server startup (tested/works)
- **`update_repec.R`**: Complete update pipeline for cron jobs (tested/works)

## Notes

- No code comments unless requested
- Focus on clean, functional code (Preference for purrr over loops)
- Use folder factory for all path operations
- Ensure backward compatibility with existing data

## Frontend Usage Notes

- Development: `cd frontend && npm install && npm run dev` (Astro dev server)
- API endpoint: by default the frontend points to `http://127.0.0.1:8000` in `frontend/src/lib/api.js` (`API_BASE`). Adjust if your backend runs elsewhere.
- Assets: logo expected at `frontend/public/logo.webp`.
