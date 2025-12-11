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
- `load_cleaned_collection()` - Load and clean all parsed papers
- `embed_and_populate_db()` - Generate embeddings and populate database
- `write_version_links_to_db()` - Get the version links table into the database
- `init_citations_tables()` - Initialize citation tables (cit_all, cit_internal)
- `parse_iscited_streaming()` - Stream parse iscited.txt into cit_all
- `build_internal_citation_graph()` - Build filtered internal citation graph
- `populate_citations()` - Main function to populate citation data
- `create_indices()` - Create database indices
- `dump_db_to_parquet()` - Backup database to Parquet (includes citation tables)
- `restore_db_from_parquet()` - Restore from Parquet backup (includes citation tables)

### API Functions
- `setup_api_pool()` - Initialize connection pool
- `run_plumber_api()` - Start API server
- `semantic_search()` - Vector similarity search
- `get_journal_stats()` - Journal statistics
- `get_category_stats()` - Category statistics
- `get_total_articles()` - Total article count
- `get_last_updated()` - Database last update date
- `get_version_links()` - Get version links for a handle
- `get_citing_papers()` - Get papers that cite a given handle
- `get_cited_papers()` - Get papers cited by a given handle
- `get_citation_counts()` - Get total and internal citation counts

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
   - Time-series: citations by year for sparklines
   - Category breakdown: citer counts and shares by journal category
   - Computed during update pipeline for fast runtime queries

### API Endpoints

- `GET /citedby?handle=...&limit=50` - Papers citing a given handle
- `GET /cites?handle=...&limit=50` - Papers cited by a given handle  
- `GET /citationcounts?handle=...` - Total and internal citation counts
- `GET /handlestats?handle=...` - Comprehensive precomputed citation statistics
- `GET /versions?handle=...` - Related paper versions
