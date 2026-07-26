import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// env.ts reads process.env once at import; set AGENTIC_PASSWORD before importing the route.
async function loadRoute() {
  vi.resetModules();
  const { exportRoute } = await import("../../src/routes/export.js");
  return exportRoute;
}

const XLSX_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

const samplePapers = [
  {
    handle: "RePEc:aaa:bbb:1",
    title: "On Things",
    authors: ["Doe, Jane", "Roe, Richard"],
    year: 2021,
    journal: "Journal of Things",
    category: "Micro",
    url: "https://example.test/1",
    abstract: "A study of things.",
  },
];

describe("POST /xlsx export route", () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it("returns an xlsx binary (200, correct content-type, ZIP magic) when gate disabled", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ papers: samplePapers }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_CT);
    const buf = new Uint8Array(await res.arrayBuffer());
    expect(buf.length).toBeGreaterThan(0);
    // xlsx is a zip — first 4 bytes are "PK\x03\x04"
    expect([buf[0], buf[1], buf[2], buf[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it("returns 400 when papers is not an array", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ papers: "x" }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when papers is missing", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 when papers is empty (min 1)", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ papers: [] }),
    });
    expect(res.status).toBe(400);
  });

  it("returns 400 on invalid JSON body", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    expect(res.status).toBe(400);
  });

  it("returns 401 without a key when the gate is enabled", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ papers: samplePapers }),
    });
    expect(res.status).toBe(401);
  });

  it("returns 200 with a valid key when the gate is enabled", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "s3cret");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer s3cret",
      },
      body: JSON.stringify({ papers: samplePapers }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe(XLSX_CT);
  });

  it("tolerates papers with missing optional fields (defaults applied)", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ papers: [{ handle: "RePEc:x:y:1" }] }),
    });
    expect(res.status).toBe(200);
  });

  it("writes a DOI column carrying the paper's DOI", async () => {
    vi.stubEnv("AGENTIC_PASSWORD", "");
    const route = await loadRoute();
    const res = await route.request("/xlsx", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        papers: [{ ...samplePapers[0], doi: "10.1234/abc.2021" }],
      }),
    });
    expect(res.status).toBe(200);

    const { default: ExcelJS } = await import("exceljs");
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(await res.arrayBuffer());
    const ws = wb.getWorksheet("Sources")!;
    const header = (ws.getRow(1).values as unknown[]).map((v) => String(v ?? ""));
    expect(header).toContain("DOI");
    const doiCol = header.indexOf("DOI");
    expect(String(ws.getRow(2).getCell(doiCol).value)).toBe("10.1234/abc.2021");
  });
});
