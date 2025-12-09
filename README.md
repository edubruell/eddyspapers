# Eddy's Papers 

A **Semantic Paper Search Engine** for economics papers from the [RePEc](https://repec.org) archives. Uses vector embeddings of Abstracts to enable natural language queries over academic publications.

## Overview

This project provides:
- Automated synchronization with RePEc archives via rsync
- RDF/ReDIF metadata parsing using Perl backend
- Semantic embeddings generation with Ollama (mxbai-embed-large model)
- Vector similarity search using DuckDB with VSS extension
- REST API built with R Plumber
- Modern web interface built with Astro and React

## Project Structure

```text
eddyspaperui/
├── backend/                 # R package for data pipeline and API
│   ├── R/                   # Package source code
│   │   ├── config.R         # Configuration utilities
│   │   ├── folders.R        # Folder reference factory
│   │   ├── sync.R           # RePEc rsync synchronization
│   │   ├── parse.R          # RDF parsing with Perl
│   │   ├── embed.R          # Embedding generation
│   │   ├── database.R       # DuckDB operations
│   │   └── api.R            # API endpoint functions
│   ├── inst/plumber/        # Plumber API definition
│   │   └── api.R
│   ├── DESCRIPTION          # Package metadata
│   └── NAMESPACE            # Exported functions
├── frontend/                # Astro + React web interface
│   ├── src/
│   │   ├── components/      # React UI components
│   │   ├── layouts/         # Astro layouts
│   │   ├── lib/             # API client
│   │   └── pages/           # Astro pages
│   └── package.json
├── data/                    # Data storage (not in repo)
│   ├── RePEc/               # Downloaded archives
│   ├── rds_archivep/        # Parsed RDF data
│   ├── db/                  # DuckDB database
│   └── journals.csv         # Journal metadata
├── run_api.R                # Start production API server
└── update_repec.R           # Update pipeline for cron jobs
```

## Features

### Backend
- **Sync**: Download and update RePEc paper archives
- **Parse**: Extract metadata from ReDIF format files
- **Embed**: Generate semantic embeddings using local Ollama instance
- **Search**: Vector similarity search with filters (year, journal, category)
- **API Endpoints**:
  - `/search`: Semantic search with multiple filters
  - `/save`: Save search queries and results
  - `/saved/:hash`: Retrieve saved searches
  - `/stats/journals`: Journal statistics
  - `/stats/categories`: Category distribution
  - `/stats/total`: Total article count
  - `/stats/last_updated`: Last database update timestamp

### Frontend
- **Two-phase UI**: Landing view transitions to sidebar layout on search
- **Semantic search**: Natural language paper queries
- **Category filtering**: 11 JEL economic categories
- **Year filtering**: Filter by minimum publication year
- **BibTeX export**: One-click citation copying
- **Expandable abstracts**: Toggle paper abstract visibility

## Requirements

### System Dependencies
- **R** (≥4.0.0)
- **Perl** with ReDIF-perl modules for parsing
- **Ollama** with mxbai-embed-large model for embeddings
- **rsync** for RePEc synchronization
- **Node.js** (≥18) for frontend development

### R Package Dependencies
- tidyverse, here, fs
- DuckDB, pool, DBI
- tidyllm (Ollama integration)
- plumber (REST API)
- rprojroot, withr, arrow, jsonlite

## Setup

### 1. Install Backend Package

```r
# Install backend package
devtools::install("backend/")
```

### 2. Configure Folders

Create `data/` directory structure:
```bash
mkdir -p data/{RePEc,rds_archivep,pqt,db}
```

Add `data/journals.csv` with journal metadata.

### 3. Install Ollama Model

```bash
ollama pull mxbai-embed-large
```

### 4. Initial Data Pipeline

```r
# Run complete update pipeline
source("update_repec.R")
```

This will:
- Sync RePEc archives
- Parse RDF files
- Generate embeddings
- Populate DuckDB database
- Create search indices

### 5. Start API Server

```r
# Start Plumber API on port 8000
source("run_api.R")
```

### 6. Start Frontend

```bash
cd frontend
npm install
npm run dev
```

Frontend will be available at `http://localhost:4321`

## Usage

### Production API
```r
source("run_api.R")
```


### Development
```bash
# Terminal 1: Start API
Rscript run_api.R

# Terminal 2: Start frontend dev server
cd frontend && npm run dev
```

## API Examples

### Search Papers
```bash
curl -X POST http://localhost:8000/search \
  -H "Content-Type: application/json" \
  -d '{
    "query": "Reductions in Gouvernment Expenditures and Political Polarization",
    "min_year": 2020,
    "limit": 10
  }'
```

### Get Statistics
```bash
curl http://localhost:8000/stats/total
curl http://localhost:8000/stats/categories
curl http://localhost:8000/stats/journals
```

## Architecture

### Data Flow
1. **Sync**: rsync downloads RePEc archives to `data/RePEc/`
2. **Parse**: Perl processes RDF files → R data frames → RDS files
3. **Embed**: tidyllm generates embeddings via Ollama
4. **Store**: DuckDB stores papers + embeddings with VSS extension
5. **Search**: Plumber API provides vector similarity search
6. **Display**: Astro/React frontend queries API and renders results


## License

MIT License

## Contact

Eduard Brüll
eduard.bruell@zew.de