// Shared builders for the three client-side exports: an evidence-rich Markdown file,
// the printable PDF document, and the source list both share. The Excel export is
// server-rendered (exceljs) and lives in api.js.

export function papersList(papers) {
  return papers ? Object.values(papers) : [];
}

function authorsStr(authors) {
  return Array.isArray(authors) && authors.length ? authors.join(", ") : "Unknown author";
}

function oneLine(s) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

// review text, then a flat "Sources" list — one field row per card:
//   N. Authors (Year) "Title", Journal
//      `RePEc:handle`
//      Abstract: …
export function buildMarkdown(synthesis, papers) {
  const review = (synthesis ?? "").trim();
  const list = papersList(papers);
  if (!list.length) return review ? `${review}\n` : "";

  const entries = list.map((p, i) => {
    const year = p.year ? ` (${p.year})` : "";
    const journal = p.journal ? `, ${oneLine(p.journal)}` : "";
    const head = `${i + 1}. ${authorsStr(p.authors)}${year} "${oneLine(p.title)}"${journal}`;
    const handle = p.handle ? `\n   \`${p.handle}\`` : "";
    const abstract = p.abstract ? `\n   Abstract: ${oneLine(p.abstract)}` : "";
    return head + handle + abstract;
  });

  const head = review ? `${review}\n\n---\n\n` : "";
  return `${head}## Sources\n\n${entries.join("\n\n")}\n`;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
}

export function sourcesHtml(papers) {
  const list = papersList(papers);
  if (!list.length) return "";
  const items = list
    .map((p) => {
      const year = p.year ? ` (${p.year})` : "";
      const journal = p.journal ? `, <em>${esc(p.journal)}</em>` : "";
      const ref = `${esc(authorsStr(p.authors))}${year} &ldquo;${esc(p.title)}&rdquo;${journal}`;
      const abstract = p.abstract ? `<p class="abs">${esc(p.abstract)}</p>` : "";
      return `<li><span class="ref">${ref}</span>${abstract}</li>`;
    })
    .join("");
  return `<h2>Sources</h2><ol class="sources">${items}</ol>`;
}

const PRINT_CSS = `
  @page { margin: 22mm 18mm; }
  * { box-sizing: border-box; }
  body { font: 15px/1.55 Georgia, "Times New Roman", serif; color: #1c1917; max-width: 720px; margin: 0 auto; padding: 12px; }
  h1, h2, h3 { font-family: Inter, system-ui, sans-serif; color: #0f172a; line-height: 1.25; }
  h2 { margin-top: 1.6em; border-bottom: 1px solid #e7e5e4; padding-bottom: 4px; }
  a { color: #1d4ed8; text-decoration: none; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #f5f5f4; padding: 0 3px; border-radius: 3px; font-size: 0.9em; }
  ol.sources { padding-left: 1.4em; }
  ol.sources li { margin: 0 0 1em; }
  ol.sources .ref { font-family: Inter, system-ui, sans-serif; font-size: 14px; }
  ol.sources .abs { margin: 4px 0 0; font-size: 13px; color: #44403c; }
  @media print { a { color: #1c1917; } }
`;

// Render the already-on-page review HTML (react-markdown output) plus the source list into
// a hidden same-page <iframe> and invoke the browser's print dialog (Save as PDF). Using an
// iframe rather than window.open avoids Chrome's pop-up blocker entirely — nothing to allow.
export function printReview({ synthesisHtml, papers, title = "Literature review" }) {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.style.cssText = "position:fixed;right:0;bottom:0;width:0;height:0;border:0;";
  document.body.appendChild(iframe);

  const win = iframe.contentWindow;
  if (!win) {
    iframe.remove();
    return false;
  }

  const body = `${synthesisHtml ?? ""}${sourcesHtml(papers)}`;
  win.document.open();
  win.document.write(
    `<!doctype html><html><head><meta charset="utf-8"><title>${esc(title)}</title>` +
      `<style>${PRINT_CSS}</style></head><body>${body}</body></html>`,
  );
  win.document.close();

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    iframe.remove();
  };
  win.onafterprint = cleanup;

  // Defer so the iframe document lays out before the print dialog snapshots it.
  setTimeout(() => {
    try {
      win.focus();
      win.print();
    } catch {
      /* user can still print manually */
    }
    // Fallback removal in case onafterprint never fires (the print itself is modal/blocking).
    setTimeout(cleanup, 60000);
  }, 250);

  return true;
}
