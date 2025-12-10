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

### ReDIF Parsing
- `parse_redif_perl(path)` - Parse single ReDIF file
- `parse_relatedworks_perl(path)` - Parse the `relatedworks.dat` file
- `post_process_entry(entry)` - Clean parsed entry
- `parse_all_journals()` - Parse all updated journals

### Database & Embeddings
- `load_cleaned_collection()` - Load and clean all parsed papers
- `embed_and_populate_db()` - Generate embeddings and populate database
- `write_version_links_to_db()` - Get the version links table into the database
- `create_indices()` - Create database indices
- `dump_db_to_parquet()` - Backup database to Parquet
- `restore_db_from_parquet()` - Restore from Parquet backup

### API Functions
- `setup_api_pool()` - Initialize connection pool
- `run_plumber_api()` - Start API server
- `semantic_search()` - Vector similarity search
- `get_journal_stats()` - Journal statistics
- `get_category_stats()` - Category statistics
- `get_total_articles()` - Total article count
- `get_last_updated()` - Database last update date

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

sync_journals_from_csv()
parse_all_journals()
embed_and_populate_db()
```

See `run_api.R` and `update_repec.R` in the project root for complete examples.
