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
│   │   └── ResultCard.jsx       # Individual paper card
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
- **Semantic search**: Natural language queries powered by embeddings
- **Category filters**: The old filters from the shiny app. 
- **Year filtering**: Filter papers by minimum publication year
- **BibTeX export**: One-click copy to clipboard for citations
- **Expandable abstracts**: Show/hide paper abstracts


## Backend Connection

The frontend currently expects the R Plumber API to be running at `http://127.0.0.1:8000`.

To start the backend:
```r
source("run_api.R")
```

The API endpoint is configured in `src/lib/api.js` (`API_BASE` constant).

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
