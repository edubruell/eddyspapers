import { writeFile, unlink } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { runSandbox } from "../../sandbox/runSandbox.js";
import type { RawSandboxEvent } from "../../sandbox/events.js";
import type { StreamEventPayload, Paper, Person, Section } from "../types.js";

export type ExecuteResult =
  | {
      ok: true;
      papers: Record<string, Paper>;
      persons: Record<string, Person>;
      sections: Section[];
      bibtex: string;
    }
  | { ok: false; message: string; timedOut: boolean };

function parseAuthors(raw: string): string[] {
  // Authors in DB are comma-joined; some entries use " and " as separator
  return raw
    .split(/\s+and\s+|,\s*/)
    .map((a) => a.trim())
    .filter((a) => a.length > 0);
}

export async function executeScript(
  script: string,
  dbPath: string,
  onEvent: (e: StreamEventPayload) => void,
  // Section-id numbering offset. In a multistage refine pass the second round's sections must
  // not reuse round-1 ids (the frontend keys/dedups sections by id). Defaults to 0.
  idOffset = 0,
): Promise<ExecuteResult> {
  const papers: Record<string, Paper> = {};
  const persons: Record<string, Person> = {};
  const sections: Section[] = [];
  let bibtex = "";
  // Track similarity per handle from paper events (for section row assembly)
  const similarityMap = new Map<string, number>();

  const tmp = join(tmpdir(), `eddysearch_exec_${Date.now()}_${Math.random().toString(36).slice(2)}.R`);
  try {
    await writeFile(tmp, script, "utf-8");

    const translateEvent = (raw: RawSandboxEvent): void => {
      switch (raw.type) {
        case "progress":
          onEvent({ type: "progress", label: raw.label, current: raw.current, total: raw.total });
          break;

        case "paper": {
          if (raw.similarity != null) similarityMap.set(raw.handle, raw.similarity);
          const paper: Paper = {
            handle: raw.handle,
            title: raw.title,
            authors: parseAuthors(raw.authors),
            year: raw.year,
            journal: raw.journal,
            category: raw.category,
            url: raw.url,
            abstract: raw.abstract ?? null,
            bibtex: "",
          };
          papers[raw.handle] = paper;
          onEvent({ type: "paper", paper });
          break;
        }

        case "section": {
          const rows = raw.handles.map((handle, i) => ({
            handle,
            rank: i + 1,
            similarity: similarityMap.get(handle),
          }));
          const section: Section = {
            id: `section-${idOffset + sections.length + 1}`,
            title: raw.title,
            mode: raw.mode ?? "custom",
            kind: "papers",
            n_total: raw.handles.length,
            n_shown: raw.handles.length,
            rows,
            note: raw.note ?? undefined,
          };
          sections.push(section);
          onEvent({ type: "section", section });
          break;
        }

        case "person": {
          const person: Person = {
            short_id: raw.short_id,
            name: raw.name,
            affiliation: raw.affiliation || null,
            homepage: raw.homepage || null,
            image_url: raw.image_url || null,
            wikipedia_url: raw.wikipedia_url || null,
            orcid: raw.orcid || null,
            url: raw.url,
            n_works: raw.n_works ?? null,
            citations: raw.citations ?? null,
            first_year: raw.first_year ?? null,
            last_year: raw.last_year ?? null,
            primary_category: raw.primary_category ?? null,
            n_matched: raw.n_matched ?? null,
            evidence: raw.evidence ?? [],
          };
          persons[raw.short_id] = person;
          onEvent({ type: "person", person });
          break;
        }

        case "person_section": {
          // Person sections reuse the Section row shape; `handle` carries the short_id.
          const rows = raw.short_ids.map((shortId, i) => ({ handle: shortId, rank: i + 1 }));
          const section: Section = {
            id: `section-${idOffset + sections.length + 1}`,
            title: raw.title,
            mode: "person",
            kind: "persons",
            n_total: raw.short_ids.length,
            n_shown: raw.short_ids.length,
            rows,
            note: raw.note ?? undefined,
          };
          sections.push(section);
          onEvent({ type: "section", section });
          break;
        }

        case "bibtex": {
          const bib = raw.bibtex ?? "";
          bibtex = bib;
          const entries = raw.entries ?? (bib ? bib.split(/^@/m).filter(Boolean).length : 0);
          onEvent({ type: "bibtex", entries, bibtex: bib });
          break;
        }

        case "note":
          // Notes before any section are opening strategy restatements — the
          // plain-language `strategy` field already covers that, and surfacing
          // the script's wording leaks internal mechanics. Only genuine
          // end-of-run caveats (which arrive after sections) are shown.
          if (sections.length > 0) {
            onEvent({ type: "progress", label: raw.markdown });
          }
          break;

        case "error":
          onEvent({ type: "error", where: "execute", message: raw.message, recoverable: raw.recoverable });
          break;
      }
    };

    const result = await runSandbox(tmp, dbPath, (raw) => translateEvent(raw));

    if (result.timedOut) {
      return { ok: false, message: "Sandbox timed out", timedOut: true };
    }

    if (result.exitCode !== 0) {
      const stderr = result.stderr.slice(0, 500);
      return {
        ok: false,
        message: `R process exited with code ${result.exitCode}${stderr ? `: ${stderr}` : ""}`,
        timedOut: false,
      };
    }

    return { ok: true, papers, persons, sections, bibtex };
  } finally {
    await unlink(tmp).catch(() => undefined);
  }
}
