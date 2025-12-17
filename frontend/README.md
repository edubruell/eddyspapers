# Semantic Economics Paper Search - Frontend

Web interface for searching economics papers from RePEc using semantic similarity.

## Project Structure

```text
frontend/
├── public/
│   ├── favicon.svg
│   └── logo.webp           # Project logo
├── src/
│   ├── assets/
│   ├── components/         # React components
│   │   ├── SearchApp.jsx        # Main app orchestrator
│   │   ├── SearchPanel.jsx      # Search controls sidebar
│   │   ├── SearchBox.jsx        # Autosizing textarea
│   │   ├── CategoryPills.jsx    # Journal category filters
│   │   ├── Results.jsx          # Results container
│   │   ├── ResultCard.jsx       # Individual paper card with BibTeX
│   │   ├── HandleDetail.jsx     # Expanded paper detail view
│   │   ├── StatsBadges.jsx      # Citation stats and time histogram
│   │   └── JournalTable.jsx     # Journal statistics table
│   ├── layouts/
│   │   └── AppLayout.astro      # Global page layout
│   ├── lib/
│   │   └── api.js              # Backend API client
│   ├── pages/
│   │   └── index.astro         # Entry point
│   └── styles/
│       └── global.css          # Global styles
├── astro.config.mjs
└── package.json
```

## Features

- **Two-phase UI**: Landing state with centered search box transitions to sidebar layout when results are shown
- **Semantic search**: Natural language queries powered by embeddings via Ollama
- **Advanced filters**: Category, year, journal name, title/author keywords
- **Citation statistics**: Total/internal citations, percentiles, citer quality metrics
- **Citation network**: View papers cited by or citing a given paper
- **Version tracking**: Related paper versions from RePEc
- **Citation timeline**: Histogram showing citations by year
- **Category breakdown**: Citer distribution by journal category
- **BibTeX export**: One-click copy to clipboard for citations
- **Expandable details**: Show/hide paper abstracts and citation stats
- **Saved searches**: Shareable URLs with search hashes
- **Journal statistics**: Overview table of article counts by journal


## Backend Connection

The frontend expects the R Plumber API to be running at `http://127.0.0.1:8000` by default.

To start the backend:
```r
source("run_api.R")
```

The API endpoint is configured in `src/lib/api.js` (`API_BASE` constant).

### API Client Functions

The `src/lib/api.js` module provides:

- `searchPapers()` - POST semantic search with filters
- `saveSearch()` - POST save search with hash
- `loadSavedSearch()` - GET retrieve saved search by hash
- `getVersions()` - GET paper version links
- `getCitedBy()` - GET papers citing a handle
- `getCites()` - GET papers cited by a handle
- `getCitationCounts()` - GET total/internal citation counts
- `getHandleStats()` - GET comprehensive citation statistics
- `getJournalStats()` - GET article counts by journal
- `getLastUpdated()` - GET database last update date

## Tech Stack

- **Astro**: Static site framework with React integration
- **React**: UI components with hooks for state management
- **Lucide React**: Icon library for UI elements

## Commands

All commands are run from the `frontend/` directory:

| Command                   | Action                                           |
| :------------------------ | :----------------------------------------------- |
| `npm install`             | Install dependencies                             |
| `npm run dev`             | Start dev server at `localhost:4321`             |
| `npm run build`           | Build production site to `./dist/`               |
| `npm run preview`         | Preview production build locally                 |
