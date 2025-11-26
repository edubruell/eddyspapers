# Semantic Economics Paper Search Engine - Refactoring Plan

## Project Overview

This is a semantic economics paper search engine that:
- Syncs academic papers from RePEc archives
- Parses RDF/ReDIF metadata files
- Generates semantic embeddings using Ollama (via tidyllm)
- Stores data in a DuckDB database with vector search (VSS extension)
- Provides a Plumber REST API for search queries

## Current State

### Existing Structure
- `/R` folder: Original scripts that need to be migrated
  - `api.R`: Plumber API with search endpoints
  - `sync_rsync_archive.R`: RePEc archive synchronization
  - `parse_rdf_perl_backend.R`: RDF file parsing using Perl backend
  - `embed_collection.R`: Embedding generation and database population
  - `config.R`: Folder configuration
  - `folder_utils.R`: Folder reference factory
  - `database_dump.R`, `restore_db_from_pqt.R`: Database utilities

- `/backend` folder: Started package refactor
  - `DESCRIPTION`: Package metadata (eddyspapersbackend)
  - `R/config.R`: Configuration functions
  - `R/folders.R`: Folder reference factory
  - `R/sync.R`: RePEc RSync synchrosnisation
  - `R/parse.R`: RDF file parsing using Perl backend
  - `R/database.R`: Embedding and database operations
  - `NAMESPACE`: Package exports

### Key Features Already Implemented
- **Folder Factory**: Configurable folder paths via environment variable `PAPER_SEARCH_DATA_ROOT`
- **Config System**: Manages paths for data_root, repec, rds, pqt, db folders
- **API Features**: Semantic search with addtional filters (year, journal, category, keywords). The standard query is a question, or a paper abstract.
- **Database**: DuckDB with VSS extension for vector similarity search

## Refactoring Goals

### 1. Backend Package Structure (`/backend`)

The backend package should contain:

**Core Functions**:
- Configuration and folder management (✓ partially done)
- RePEc sync utilities (to migrate from `sync_rsync_archive.R`)
- RDF parsing utilities (to migrate from `parse_rdf_perl_backend.R`)
- Embedding generation (to migrate from `embed_collection.R`)
- Database utilities (to migrate from `database_dump.R`, `restore_db_from_pqt.R`)

**Plumber API**:
- should be developed from `/R/api.R`: Plumber API with search endpoints
- Search endpoint with semantic similarity
- Stats endpoints (journals, categories, total count, last updated)
- Database connection pooling
- Filter capabilities (year, journal, category, title/author keywords)

**Package Structure**:
```
backend/
├── DESCRIPTION
├── NAMESPACE
├── R/
│   ├── config.R         ✓ Done
│   ├── folders.R        ✓ Done
│   ├── sync.R           ✓ Done
│   ├── parse.R          ✓ Done
│   ├── embed.R          ✓ Done
│   ├── database.R       ✓ Done
│   └── api.R            To create (from api.R)
├── inst/
│   └── plumber/
│       └── api.R        Plumber API definition
└── man/                 Documentation (to generate)
```

### 2. Main Folder Scripts

The main project folder should have lightweight scripts that:
- Load the backend package
- Configure folder paths
- Invoke package functions

**Scripts to Create**:

1. **`run_api.R`**: Start the Plumber API
   - Load backend package
   - Configure folders (via env var or defaults)
   - Initialize database connection pool
   - Start Plumber API

2. **`update_repec.R`**: Cron job script for RePEc updates
   - Load backend package
   - Configure folders
   - Sync RePEc archives
   - Parse new/updated RDF files
   - Generate embeddings for new papers
   - Update database and indices

### 3. Frontend Structure (`/frontend`)

Separate folder for Svelte UI (to be developed later):
```
frontend/
├── package.json
├── svelte.config.js
├── src/
│   ├── routes/
│   └── lib/
└── static/
```

## Technical Details

### Configuration
- Environment variable: `PAPER_SEARCH_DATA_ROOT` (defaults to `./data`)
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

### Phase 3: Future Frontend (Not in Scope Yet)
- [ ] Set up Svelte project
- [ ] Create search UI
- [ ] Connect to backend API

## Refactoring Complete! 🎉

The backend package refactoring is complete. Here's what's ready:

### Backend Package (`backend/`)
All functions are documented and exported:
- **Config**: `get_folder_config()`, `ensure_folders()`
- **Folders**: `get_folder_refs()`
- **Sync**: `sync_repec_folder()`, `sync_journals_from_csv()`
- **Parse**: `parse_redif_perl()`, `post_process_entry()`, `parse_all_journals()`
- **Database**: `load_cleaned_collection()`, `embed_and_populate_db()`, `create_indices()`, `dump_db_to_parquet()`, `restore_db_from_parquet()`
- **API**: `setup_api_pool()`, `get_api_pool()`, `close_api_pool()`, `semantic_search()`, `get_journal_stats()`, `get_total_articles()`, `get_category_stats()`, `get_last_updated()`, `run_plumber_api()`

### Main Scripts
- **`run_api.R`**: Production API server startup
- **`update_repec.R`**: Complete update pipeline for cron jobs

### Next Steps for Developer
1. Review the refactored code
2. Test the backend package installation: `devtools::load_all("backend")`
3. Test the API: `Rscript run_api.R`
4. Set up cron job for updates: `Rscript update_repec.R`
5. Clean up old `/R` folder files (keep for reference during transition)
6. Consider generating man pages: `devtools::document("backend")`

## Notes

- Document and export functions so they are useable from the package
- Keep the package simple and extensible with other repec features
- No code comments unless requested
- Focus on clean, functional code (Preference for purrr over loops)
- Use folder factory for all path operations
- Ensure backward compatibility with existing data
