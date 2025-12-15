# Semantic Economics Paper Search Engine - Status and Plan

## Project Overview

This is a semantic economics paper search engine that:
- Syncs academic papers from RePEc archives
- Parses RDF/ReDIF metadata files
- Generates semantic embeddings using Ollama (via tidyllm)
- Stores data in a DuckDB database with vector search (VSS extension)
- Provides a Plumber REST API for search queries

## Current State (as of 2025-12-11)

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

The frontend is built with Astro and React components. On desktop, it has a two-phase UI:
- Landing state: centered logo and wider search box.
- Results state: left sidebar with logo + search controls; right pane with results.

Key components (React):
- `SearchApp.jsx`: top-level state and layout; orchestrates search.
- `SearchPanel.jsx`: query textarea, category pills, min-year, search button.
- `CategoryPills.jsx`: selectable journal category chips.
- `Results.jsx`: renders results only after a search was triggered.
- `ResultCard.jsx`: individual paper card with copy-to-clipboard BibTeX and expand/collapse abstract.
- `SearchBox.jsx`: autosizing textarea input.
- `HandleDeatil.jsx`: Detailed expanded view info for `ResultCard`
- `StatsBadges.jsx`: Statistics Badges and a citation time histogram shown in `HandleDeatil`

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





### Phase 4: Citation Integration (IN PROGRESS)

**Goal:** Integrate RePEc citation data (iscited.txt) into backend with three-table design for performance.

#### Citation Architecture

**Three-Table Design:**

1. **`cit_all`** - Full citation graph (all edges from iscited.txt)
   - Columns: `citing VARCHAR`, `cited VARCHAR`
   - Indices: on both citing and cited
   - Purpose: Complete citation counts, includes papers outside our DB
   - Size: ~34M rows

2. **`cit_internal`** - Internal citation graph (both ends in our articles DB)
   - Columns: `citing VARCHAR`, `cited VARCHAR`
   - Indices: on both citing and cited
   - Purpose: Network analysis, metadata-rich queries
   - Derived from `cit_all` filtered to our corpus (If we ever scale to all of RePEc anything we do for `cit_internal` has to scale to `cit_all`)

3. **`handle_stats`** - Precomputed citation statistics
   - Purpose: Fast runtime queries, no joins needed
   - Updated during sync pipeline, not at query time
   - Includes first-order metrics (citations, references, percentiles)
   - Includes second-order metrics (citer quality, Top 5 share, weighted citations)
   - Includes time-series data (citations by year) and category breakdowns

4. **`bib_coupling`** - Precomputed table for bibliographic coupling (Future)
   - Purpose: Show the top 5 or 10 papers with the most similar references

#### Update Pipeline (with citations)

```r
# update_repec.R order:
1. Sync journals (rsync)
2. Parse RDF files
3. Embed & populate articles table
4. Write version links
5. Sync iscited.txt
6. Parse & populate cit_all
7. Build cit_internal
8. Compute handle_stats         
9. Dump to parquet
```

#### API Endpoints

## API Endpoints

- POST `/search`  
  Semantic search with vector similarity and filters (year, journal, title, author).

- POST `/search/save`  
  Save a search request and its results; returns deterministic hash.

- GET `/search/{hash}`  
  Load a previously saved search by hash.

- GET `/versions?handle=...`  
  Retrieve all known versions of a paper.

- GET `/cites?handle=...&limit=50`  
  Papers referenced by a given handle (internal citations only).

- GET `/citedby?handle=...&limit=50`  
  Papers citing a given handle (internal citations only).

- GET `/citationcounts?handle=...`  
  Total vs internal citation counts (precomputed).

- GET `/handlestats?handle=...`  
  Full precomputed citation and impact statistics for a handle.
  
- GET `/stats/journals`  
  Article counts by journal or category.
  
- GET `/stats/last_updated`  
  Date of last successful RePEc update.


### Main Scripts to work with the packaged backend
- **`run_api.R`**: Production API server startup (tested/works)
- **`update_repec.R`**: Complete update pipeline for cron jobs (tested/works)

## Notes

- No code comments unless requested
- Focus on clean, functional code (Preference for purrr over loops)
- Use folder factory for all path operations
- Work within the database when possible but avoid SQL-Spaghetti 
- Separate Tables when possible
- Ensure backward compatibility with existing data

## Frontend Usage Notes

- Development: `cd frontend && npm install && npm run dev` (Astro dev server)
- API endpoint: by default the frontend points to `http://127.0.0.1:8000` in `frontend/src/lib/api.js` (`API_BASE`). Adjust if your backend runs elsewhere.
