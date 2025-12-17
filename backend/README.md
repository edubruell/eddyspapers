# eddyspapersbackend

Backend package for the Semantic Economics Paper Search Engine.

## Installation

```r
devtools::load_all("backend")
```

## Configuration

Set the data root folder via environment variable:

```r
Sys.setenv(PAPER_SEARCH_DATA_ROOT = "/path/to/data")
```

Defaults to `./data` if not set.

## Core Functions

### Configuration
- `get_folder_config()` - Get folder paths
- `ensure_folders()` - Create required directories
- `get_folder_refs()` - Get folder reference functions

### RePEc Sync
- `list_repec_folder()` - List files in a RePEc archive via rsync (without downloading)
- `sync_repec_folder(archive, journal)` - Sync single archive/journal
- `sync_journals_from_csv()` - Sync all journals from CSV
- `sync_repec_cpd_conf()` - Sync the related works from RePEc
- `sync_repec_iscited()` - Sync citation data (iscited.txt) from RePEc

### ReDIF Parsing
- `parse_redif_perl(path)` - Parse single ReDIF file
- `parse_relatedworks_perl(path)` - Parse the `relatedworks.dat` file
- `post_process_entry(entry)` - Clean parsed entry
- `parse_all_journals()` - Parse all updated journals

### Database & Embeddings
- `get_db_con()` - Get DuckDB connection with VSS extension loaded
- `load_cleaned_collection()` - Load and clean all parsed papers
- `embed_and_populate_db()` - Generate embeddings and populate database
- `write_version_links_to_db()` - Get the version links table into the database
- `init_citations_tables()` - Initialize citation tables (cit_all, cit_internal)
- `parse_iscited_streaming()` - Stream parse iscited.txt into cit_all
- `build_internal_citation_graph()` - Build filtered internal citation graph
- `populate_citations()` - Main function to populate citation data
- `create_indices()` - Create database indices (B-tree and HNSW)
- `record_db_update_time()` - Record last successful database update timestamp
- `get_db_info()` - Get database tables with sizes and schemas
- `dump_db_to_parquet()` - Backup database to Parquet (includes citation tables)
- `restore_db_from_parquet()` - Restore from Parquet backup (includes citation tables)

### Citation Statistics
- `init_handle_stats_table()` - Initialize handle_stats table schema
- `compute_handle_stats()` - Compute comprehensive citation statistics for all articles
- `get_handle_stats()` - Retrieve precomputed statistics for article handles

### API Functions

**Connection Pool:**
- `setup_api_pool()` - Initialize connection pool
- `get_api_pool()` - Get current connection pool
- `close_api_pool()` - Close and clean up connection pool
- `run_plumber_api()` - Start API server

**Search & Statistics:**
- `semantic_search()` - Vector similarity search with filters
- `get_journal_stats()` - Journal statistics
- `get_category_stats()` - Category statistics
- `get_total_articles()` - Total article count
- `get_last_updated()` - Database last update date

**Citations & Versions:**
- `get_version_links()` - Get version links for a source handle with metadata
- `get_citing_papers()` - Get papers that cite a given handle (internal)
- `get_cited_papers()` - Get papers cited by a given handle (internal)
- `get_citation_counts()` - Get total and internal citation counts
- `get_handle_stats_api()` - Get precomputed handle statistics from handle_stats table

**Search Persistence:**
- `ensure_saved_searches_table()` - Initialize saved searches table
- `generate_search_hash()` - Generate deterministic hash from search parameters
- `save_search()` - Save search query and results with hash
- `get_saved_search()` - Retrieve saved search by hash

**Search Analytics:**
- `ensure_search_logs_table()` - Initialize search logs table
- `log_search()` - Log search query with IP, filters, and timing
- `get_search_stats()` - Get aggregated search log statistics

## External Requirements

- Perl with ReDIF-perl modules (for parsing)
- Ollama with mxbai-embed-large model (for embeddings)
- rsync (for RePEc synchronization)

## Usage Examples

### Start API Server

```r
library(eddyspapersbackend)
run_plumber_api(host = "0.0.0.0", port = 8000)
```

### Update Pipeline

```r
library(eddyspapersbackend)

config <- get_folder_config()
ensure_folders(config)

# Sync and parse
sync_journals_from_csv()
parse_all_journals()

# Embeddings and database
embed_and_populate_db()

# Version links
write_version_links_to_db()

# Citation data
iscited_file <- sync_repec_iscited()
populate_citations(iscited_file = iscited_file)

# Citation statistics
con <- DBI::dbConnect(duckdb::duckdb(), file.path(config$db_folder, "articles.duckdb"))
compute_handle_stats(con)
DBI::dbDisconnect(con)

# Backup
dump_db_to_parquet()
```

See `run_api.R` and `update_repec.R` in the project root for complete examples.

## Citation System

The backend implements a three-table citation architecture:

1. **`cit_all`** - Full citation graph (~10M edges) from RePEc iscited.txt
   - Includes all citations, even to papers outside our database
   - Used for accurate total citation counts

2. **`cit_internal`** - Internal citation graph (~1M edges)
   - Only citations between papers in our database
   - Used for queries with full paper metadata
   - Enables network analysis within our corpus

3. **`handle_stats`** - Precomputed citation statistics
   - First-order: total citations, internal citations, references, citations per year, percentiles
   - Second-order: median/mean/max citer percentile, weighted citations, Top 5 share
   - Time-series: citations by year for sparklines/histograms
   - Category breakdown: citer counts and shares by journal category
   - Top citing journal for each handle
   - Computed during update pipeline using temp views for fast runtime queries
   - Updated via `compute_handle_stats()` after citation graph is built

### API Endpoints

**Search:**
- `POST /search` - Semantic search with filters (year, journal, title, author)
- `POST /search/save` - Save search request and results; returns deterministic hash
- `GET /search/{hash}` - Load previously saved search by hash

**Citations & Versions:**
- `GET /citedby?handle=...&limit=50` - Papers citing a given handle (internal)
- `GET /cites?handle=...&limit=50` - Papers cited by a given handle (internal)
- `GET /citationcounts?handle=...` - Total vs internal citation counts
- `GET /handlestats?handle=...` - Comprehensive precomputed citation statistics
- `GET /versions?handle=...` - Related paper versions

**Statistics:**
- `GET /stats/journals` - Article counts by journal
- `GET /stats/categories` - Article counts by category
- `GET /stats/total` - Total article count
- `GET /stats/last_updated` - Date of last successful RePEc update
