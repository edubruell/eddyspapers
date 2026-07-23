# Eddy's Papers
![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)
![Screenshot of Eddy's Papers semantic search interface](assets/screenshot.webp)

Three products sharing one DuckDB corpus of ~479k economics papers from [RePEc](https://repec.org).

| Product | What it does | Live |
|---|---|---|
| **Classic search** | Natural-language semantic search over paper abstracts | [econpapers.eduard-bruell.de](https://econpapers.eduard-bruell.de) |
| **EconPeople** | Finds economists by research topic instead of finding papers | [econpeople.eduard-bruell.de](https://econpeople.eduard-bruell.de) |
| **Agentic Search** | Multi-turn assistant that turns a research brief into a synthesized literature review | [agenticsearch.eduard-bruell.de](https://agenticsearch.eduard-bruell.de) |

All three are served by one Node/Hono API (`api/`). Only the R pipeline (`pipeline/`) writes to the corpus; the API is read-only against it, plus a separate appdata store for saved searches, keys and logs.

## Project structure

```text
eddyspapers/
├── pipeline/                # R package `eddyspapersbackend`, the data pipeline
│   ├── R/                   # config, folders, sync, parse, database, handle_stats,
│   │                           persons, persons_wikidata, update_logs
│   └── inst/scripts/        # Perl ReDIF parsers
├── api/                     # Hono + TypeScript service, serves all three products
│   ├── src/                 # routes, search, auth, db, MCP, sandbox bridge
│   └── tests/
├── sandbox/                 # R sandbox for the agentic pipeline
│   ├── eddysearch.sandbox/  # R package with the verbs the agent calls
│   ├── run.R                # sandbox subprocess entry point
│   └── check.R              # static AST checks on generated scripts
├── frontends/               # Astro + React web interfaces (shared palette)
│   ├── classic/              # Classic semantic search
│   ├── econpeople/           # EconPeople person finder
│   └── agentic/               # Agentic literature review (LLM-guided search in code + LLM synthesis)
├── assets/                  # shared source assets (logo, screenshot)
├── stats/                   # analysis scripts for usage stats
├── maintenance/             # static maintenance page
├── data/                    # data storage (not in repo)
│   ├── RePEc/                # downloaded archives
│   ├── rds_archivep/         # parsed RDF data
│   ├── db/                   # DuckDB database
│   └── journals.csv          # journal metadata
├── update_repec.R           # update pipeline for cron jobs
├── deploy_diffs.sh          # manual diff upload + snapshot reload on the server
├── server_apply_diff.R      # runs on the server inside deploy_diffs.sh
└── diff_upload.R            # rsync upload helper
```

## Data flow

```
R pipeline (cron / update_repec.R)
  sync (rsync RePEc) -> parse (Perl ReDIF) -> embed (Ollama, tidyllm)
  -> write articles.duckdb --atomic swap--> articles_agentic.duckdb (read-only snapshot)
                                                    |
                                          Hono API (api/, :8001)
                                             |- /search, /person/*, /stats/*   -> classic + EconPeople
                                             |- /cites, /citedby, /handlestats
                                             `- /chat, /export/*               -> agentic pipeline
                                                    `- R sandbox subprocess (eddysearch.sandbox)
```

## Requirements

### System dependencies
- **R** (>=4.0.0)
- **Perl** with ReDIF-perl modules for parsing
- **Ollama** with mxbai-embed-large model for embeddings
- **rsync** for RePEc synchronization
- **Node.js** (>=18) for frontend development

### R package dependencies
- dplyr, tidyr, purrr, readr, stringr, glue, tibble, lubridate
- here, fs, rprojroot, withr, R.utils
- duckdb, DBI
- tidyllm (Ollama integration), httr2, processx, jsonlite

## Setup

### 1. Install the pipeline package

```r
devtools::install("pipeline/")
```

### 2. Configure folders

Create the `data/` directory structure:
```bash
mkdir -p data/{RePEc,rds_archivep,pqt,pqt_diff,db}
```

Add `data/journals.csv` with journal metadata.

### 3. Install the Ollama model

```bash
ollama pull mxbai-embed-large
```

### 4. Run the initial data pipeline

```r
source("update_repec.R")
```

This syncs RePEc archives, parses RDF files, generates embeddings, populates DuckDB and creates search indices.

### 5. Backend (Hono + TS)

```bash
# listens on http://127.0.0.1:8001
pnpm install          # at the repo root (workspace)
cd api && pnpm dev
```

### 6. Frontends (Astro + React)

```bash
cd frontends/classic && npm install && npm run dev
cd frontends/econpeople && npm install && npm run dev
cd frontends/agentic && npm install && npm run dev
```

## License

MIT License

## Contact

Eduard Bruell
eduard.bruell@zew.de
