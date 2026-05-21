export const semanticQueryGuidePrompt = `\
## Semantic query writing guide

The embedding model was trained on paper abstracts. The query should therefore be written
**as a mock abstract** — a short hypothetical paper that would be a perfect result for this
section. This is the single most important technique for getting good results.

### Core principle: write a fake abstract, not a question

Bad:  "minimum wage effects on employment Germany"
Also bad: "How do minimum wages affect employment in Germany?"
Good: "This paper examines the employment effects of the 2015 minimum wage introduction in
      Germany using linked employer-employee administrative data. Exploiting regional variation
      in wage bite, we find that employment in affected low-wage establishments declined by
      2–3 percent, concentrated among part-time and marginal workers."

The bad queries are questions or labels — distant from what is actually in the DB.
The good query is syntactically and semantically close to real abstracts, so it lands in
the right neighbourhood of the embedding space.

### How to write the mock abstract

The brief will usually give you enough to construct it. Use whatever context the user
provided — if they mention Germany, include Germany; if they mention RCT, include RCT.
If there is no context, pick reasonable assumptions and write a plausible abstract.

A good mock abstract contains 2–4 of these elements (not all are needed every time):
- **Topic and outcome**: what the paper studies and what it measures
- **Method or identification**: how causality is established (RD, DiD, IV, event study, bunching, RCT)
- **Data or context**: what dataset or country, if relevant
- **Finding**: a plausible (not accurate) result, written as if true

You do not need the finding to be correct — the embedding ignores numeric values.
What matters is that the abstract *type* matches: a quasi-experimental paper on wages
will cluster near other quasi-experimental papers on wages, regardless of the exact estimate.

### Vary the framing across sections to cover different clusters

Each semantic_search call sweeps a different neighbourhood. Run 2–4 sections with
systematically varied framings — same topic, different emphasis:

  Section 1 mock abstract: emphasises the mechanism and labour market outcome
  Section 2 mock abstract: emphasises the identification strategy and data
  Section 3 mock abstract: emphasises geographic/policy context (Germany, 2015 reform)

Identical or near-identical abstracts return near-identical result sets — wasted tokens.

### Include context when it helps

If the brief specifies a country, data source, or institutional setting, include it in
the mock abstract — the model knows that "IAB Beschäftigungsstatistik" signals German
administrative data and will cluster the query near those papers.

Useful context phrases:
  "linked employer-employee administrative data" / "IAB establishment panel" /
  "Bundesagentur für Arbeit" / "SOEP" / "CPS" / "UK Labour Force Survey" /
  "regression discontinuity at the wage threshold" / "bunching estimator" /
  "shift-share instrument" / "staggered difference-in-differences"

### Target length

2–4 sentences. One sentence is underspecified. Five or more starts diluting the signal.

### Journal filter guidance

Use journal_filter = NULL for the first section (broadest sweep) to avoid missing the
key paper that landed in a field journal. Add a quality filter on a second section if
the brief asks for top-journal evidence specifically. Working papers get their own section
with journal_filter = c("Working Paper Series") and min_year for recency.
`;
