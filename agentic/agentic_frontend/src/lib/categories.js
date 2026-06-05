// Exact DB category strings (must match agentic_backend journalCategories).
export const CATEGORY_DEFS = [
  { id: "top5", label: "Top 5", api: "Top 5 Journals" },
  { id: "general", label: "General Interest", api: "General Interest" },
  { id: "aej", label: "AEJs", api: "AEJs" },
  { id: "topA", label: "Top Field (A)", api: "Top Field Journals (A)" },
  { id: "secondB", label: "Second in Field (B)", api: "Second in Field Journals (B)" },
  { id: "other", label: "Other Journals", api: "Other Journals" },
  { id: "wp", label: "Working Paper", api: "Working Paper Series" },
];

export const DEFAULT_CATEGORY_IDS = ["top5", "general", "aej", "topA", "secondB"];
