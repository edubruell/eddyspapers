export const semanticQueryGuidePrompt = `\
## Semantic query writing guide

Semantic search uses dense vector embeddings — it matches meaning, not keywords. Writing a
good query is different from writing a database keyword search.

### Core principle: describe the mechanism or phenomenon, not the topic label

Bad:  "minimum wage Germany"
Good: "How do minimum wage floors affect employment levels, hours worked, and worker welfare
       in low-wage sectors? Studies using policy discontinuities or wage distribution bunching
       to identify employment effects."

The bad query gives the model a label. The good query describes *what the papers in this
cluster are about* — their research question, the variation they exploit, and what outcome
they measure. This is the mental model shift that matters most.

### Include method words when relevant

If the brief calls for causal evidence, include causal identification methods in the query.
The embedding space clusters papers by method as well as topic.

  "quasi-experimental" / "natural experiment" / "regression discontinuity" / "IV" /
  "difference-in-differences" / "synthetic control" / "RCT" / "matched panel" /
  "event study" / "bunching estimator" / "shift-share"

### Include context words when the brief is geographically or data-specific

  "administrative linked employer-employee data" / "German IAB establishment panel" /
  "Bundesagentur für Arbeit" / "European Social Survey" / "SOEP" / "BHPS" / "CPS" /
  "census microdata" / "tax records"

### Vary the framing across sections

Each call to semantic_search is a separate vector search. Sections should vary the
framing to cover different parts of the relevant paper cluster:

  Section 1: mechanism framing ("how minimum wages affect employment through hours margin")
  Section 2: methods framing ("bunching estimators and regression discontinuity designs for wage policy")
  Section 3: context framing ("German minimum wage introduction evidence labor market outcomes")

Identical or near-identical queries will return nearly identical result sets — wasted tokens.

### Target length

3–6 dense sentences per query. One sentence is too short (underspecified embedding).
More than 8 sentences starts diluting the signal.

### Do not over-specify journal filters

If the brief does not restrict to a quality tier, use journal_filter = NULL for the first
section (broadest sweep), then optionally add a second section with a quality filter.
Over-filtering with Top 5 only risks missing the definitive paper that landed in a field journal.
`;
