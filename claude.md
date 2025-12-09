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
- `/backend` folder: Started package refactor
  - `DESCRIPTION`: Package metadata (eddyspapersbackend)
  - `R/config.R`: Configuration functions
  - `R/folders.R`: Folder reference factory
  - `R/sync.R`: RePEc RSync synchrosnisation
  - `R/parse.R`: RDF file parsing using Perl backend
  - `R/database.R`: Embedding and database operations
  - `NAMESPACE`: Package exports

## Deisgn Layout

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

### Phase 3: Future Frontend 
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
- **`run_api.R`**: Production API server startup (tested/works)
- **`update_repec.R`**: Complete update pipeline for cron jobs (tested/works)

## Notes

- No code comments unless requested
- Focus on clean, functional code (Preference for purrr over loops)
- Use folder factory for all path operations
- Ensure backward compatibility with existing data
