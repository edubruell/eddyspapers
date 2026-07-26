import { Hono } from "hono";
import ExcelJS from "exceljs";
import { z } from "zod";
import { requireKey } from "../middleware/requireKey.js";

// One row per collected source. Mirrors the Paper shape the frontend holds in its store;
// abstracts can be long, so the column is wrapped rather than truncated.
const paperSchema = z.object({
  handle: z.string(),
  title: z.string().default(""),
  authors: z.array(z.string()).default([]),
  year: z.number().nullable().optional(),
  journal: z.string().default(""),
  category: z.string().default(""),
  url: z.string().default(""),
  doi: z.string().nullable().optional(),
  abstract: z.string().nullable().optional(),
});

const bodySchema = z.object({
  papers: z.array(paperSchema).min(1).max(2000),
});

export const exportRoute = new Hono();
exportRoute.use("*", requireKey("rest"));

exportRoute.post("/xlsx", async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: "Invalid JSON body" }, 400);
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: parsed.error.issues }, 400);
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sources");
  ws.columns = [
    { header: "Authors", key: "authors", width: 34 },
    { header: "Year", key: "year", width: 8 },
    { header: "Title", key: "title", width: 56 },
    { header: "Journal", key: "journal", width: 34 },
    { header: "Category", key: "category", width: 18 },
    { header: "Handle", key: "handle", width: 28 },
    { header: "DOI", key: "doi", width: 28 },
    { header: "URL", key: "url", width: 40 },
    { header: "Abstract", key: "abstract", width: 80 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.views = [{ state: "frozen", ySplit: 1 }];

  for (const p of parsed.data.papers) {
    ws.addRow({
      authors: p.authors.join(", "),
      year: p.year ?? null,
      title: p.title,
      journal: p.journal,
      category: p.category,
      handle: p.handle,
      doi: p.doi ?? "",
      url: p.url,
      abstract: p.abstract ?? "",
    });
  }
  ws.getColumn("abstract").alignment = { wrapText: true, vertical: "top" };
  ws.getColumn("title").alignment = { wrapText: true, vertical: "top" };

  const buffer = await wb.xlsx.writeBuffer();
  return new Response(buffer, {
    status: 200,
    headers: {
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": 'attachment; filename="sources.xlsx"',
    },
  });
});
