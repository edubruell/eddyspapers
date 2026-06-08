# EconPeople — Profile Display Tiers

Person profiles vary enormously in data richness. The UI must degrade gracefully
across four tiers rather than showing empty sections. Each tier is a superset of
the tier below it — always show everything available, but only show sections when
they have content.

---

## Tier 1 — Nobel / star economists

**Examples:** Daron Acemoglu (`pac16`), James Heckman (`phe22`), Emmanuel Saez (`psa117`)

**Data available:**
- Full Wikidata: photo, birth year + place, citizenships
- PhD advisor(s) and 20–75 doctoral students (academic genealogy)
- 9–14 awards including named prizes
- Google Scholar ID, Wikipedia page
- 300+ papers in corpus, citations in the tens of thousands
- 5–13 editorial roles (journals resolved via journals.csv)
- Active homepage

**UI treatment:**
- Header: large photo left, name + workplace + homepage + external link buttons right
- Link buttons: IDEAS · Wikipedia · Google Scholar · (ORCID if present) · (website if present)
- Stats bar: corpus papers · total citations · active years · primary category
- Awards ribbon (collapsed by default if > 5, expand on click)
- Academic genealogy card: advisor → self → doctoral students (paginated if > 10)
- Editorial roles card (journals only, categories shown)
- Category breakdown bar chart
- Full publication list (paginated, expandable abstracts)

---

## Tier 2 — Established researchers with Wikidata

**Examples:** Jason Shogren (`psh64`), Helena Skyt Nielsen (`pni18`), Fernando Broner (`pbr162`)

**Data available:**
- Wikidata present but thinner: birth year, maybe birth place, ≤ 2 awards
- No image, no doctoral students listed, no academic genealogy
- Google Scholar ID usually present
- 50–200 papers in corpus, hundreds to low thousands of citations
- May have editorial roles
- Homepage usually present

**UI treatment:**
- Header: no photo — name + workplace prominent, external link buttons
- Link buttons: IDEAS · (Wikipedia if present) · (Google Scholar if present) · (website if present)
- Stats bar: same as Tier 1
- Awards: show inline (not collapsed) if ≤ 3
- No genealogy card (section omitted entirely when no advisors/students)
- Editorial roles card if any
- Category breakdown
- Publication list

---

## Tier 3 — Active researchers, no Wikidata

**Examples:** Alessandro Acquisti (`pac8`), Misa Tanaka (`pta191`)

**Data available:**
- RePEC data only: name, workplace (if set), homepage, registered date
- Corpus papers (often small subset of their total works), citation count
- No genealogy, no awards, no external IDs beyond IDEAS

**UI treatment:**
- Header: name + workplace + homepage
- Link buttons: IDEAS only (always available from short_id)
- Stats bar: corpus papers · citations · active years
- No Wikidata sections (awards, genealogy, image all omitted)
- Category breakdown if ≥ 2 categories
- Publication list (may include many out-of-corpus handles)
- Small note: "Enrich this profile on Wikidata" link pointing to a P2428 search

---

## Tier 4 — Early-career / sparse profiles

**Examples:** Eduard Brüll (`pbr907`), newly registered authors

**Data available:**
- Name, maybe homepage
- A handful of corpus papers (< 10), low citations
- Workplace may be empty (common RePEC gap)
- No Wikidata, no editorial roles

**UI treatment:**
- Minimal header: name + (homepage if set)
- Link buttons: IDEAS only
- Stats bar: show what's available; omit years if only 1–2 papers
- Publication list is the main content — lean into the paper cards
- No empty section placeholders — only render sections with content

---

## External link buttons (all tiers)

Always render as icon + label pill buttons in a horizontal strip below the name.
Show only buttons for which the value is non-null:

| Button | Icon | Source | Always? |
|---|---|---|---|
| Homepage | 🌐 globe (lucide `Globe`) | `persons.homepage` | if present |
| IDEAS profile | custom IDEAS favicon / `BookOpen` | `short_id` → `https://ideas.repec.org/e/{short_id}.html` | ✓ always |
| Google Scholar | Scholar favicon / `GraduationCap` | `person_wikidata.google_scholar_id` → `https://scholar.google.com/citations?user={id}` | if present |
| Wikipedia | Wikipedia favicon / `BookMarked` | `person_wikidata.wikipedia_url` | if present |
| ORCID | ORCID logo (green iD) | `person_wikidata.orcid` → `https://orcid.org/{orcid}` | if present |
| SSRN | `FileText` | `person_wikidata.ssrn_author_id` → `https://papers.ssrn.com/sol3/cf_dev/AbsByAuth.cfm?per_id={id}` | if present |
| Math Genealogy | `GitBranch` | `person_wikidata.math_genealogy_id` → `https://www.genealogy.math.ndsu.nodak.edu/id.php?id={id}` | if present |

Order: Homepage · IDEAS · Google Scholar · Wikipedia · ORCID · SSRN · Math Genealogy

Render as small pill buttons (icon + label, opens in new tab). Use brand favicons where
available as `<img>` (16×16); fall back to lucide-react icons if favicon loading fails.

---

## Implementation notes

- All section visibility is data-driven: render a section only when it has ≥ 1 item
- No "N/A" or "—" placeholders — absence = omission
- The tier classification is implicit (no explicit tier field needed); the UI adapts
  to whatever combination of fields is present
- Photo: use `image_url` from Wikidata; Wikimedia Commons URLs need no proxy
- The IDEAS URL is always constructible: `https://ideas.repec.org/e/{short_id}.html`
- Google Scholar URL: `https://scholar.google.com/citations?user={google_scholar_id}`
- SSRN URL: `https://papers.ssrn.com/sol3/cf_dev/AbsByAuth.cfm?per_id={ssrn_author_id}`
- MGP URL: `https://www.genealogy.math.ndsu.nodak.edu/id.php?id={math_genealogy_id}`
