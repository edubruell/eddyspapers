export const journalCategoriesPrompt = `\
## Journal categories in the database

The category field in the articles table uses these tier labels. Use them in journal_filter
to restrict semantic_search to quality tiers. Multiple tiers can be combined as a vector.

| Category label (exact DB value)  | Representative journals / series                                          |
|----------------------------------|---------------------------------------------------------------------------|
| Top 5 Journals                   | American Economic Review, QJE, JPE, Econometrica, Review of Economic Studies (~10k articles) |
| AEJs                             | AEJ: Applied Economics, AEJ: Macroeconomics, AEJ: Economic Policy, AEJ: Micro (~6k) |
| Top Field Journals (A)           | Journal of Labor Economics, Journal of Public Economics, JME, JIE, JDE,  |
|                                  | Journal of Finance, JFE, Review of Financial Studies, JET, JEEM, RAND,   |
|                                  | Journal of Health Economics, Journal of Human Resources, JUE (~44k)       |
| General Interest                 | Economic Journal, Review of Economics and Statistics, JEP, Oxford EP,    |
|                                  | Scandinavian JE, Canadian JE, European Economic Review, JEEA,             |
|                                  | Journal of Economic Behavior & Organization, Economica (~72k)             |
| Second in Field Journals (B)     | Labour Economics, JEDC, International Economic Review, Economics Letters, |
|                                  | Journal of Macroeconomics, Journal of Banking & Finance, JPAM,            |
|                                  | Journal of Population Economics, Economics of Education Review (~86k)     |
| Other Journals                   | Further peer-reviewed journals not in the tiers above (~90k)              |
| Working Paper Series             | NBER, IZA, CESifo, ZEW, DIW, Bundesbank, ECB, CEPR, Fed working papers   |
|                                  | (~157k articles — largest category)                                       |

### Notes on tier selection

**IMPORTANT: Use the exact category label strings from the table above in journal_filter.**
Wrong: c("Top 5", "AEJ", "Working Paper")
Right: c("Top 5 Journals", "AEJs", "Working Paper Series")

**For published-work quality filters:**
  c("Top 5 Journals", "AEJs", "Top Field Journals (A)")
    — top-tier journals only (high confidence, smaller set)
  c("Top 5 Journals", "AEJs", "Top Field Journals (A)", "General Interest")
    — add second-tier general journals
  c("Top 5 Journals", "AEJs", "Top Field Journals (A)", "General Interest", "Second in Field Journals (B)")
    — broad published sweep

**For working papers specifically:**
  journal_filter = c("Working Paper Series")  — all preprint series (~157k articles)
  Use min_year = 2019L to focus on recent WPs; avoid combining WP with published tiers
  in one call (better to run separate sections for WPs and published work).

**Working Paper series coverage:**
  NBER, IZA, CESifo, ZEW, DIW, Bundesbank, ECB, CEPR, Fed systems.
  Series overlap significantly with published versions — use versions() to find
  the journal version of a given WP handle if needed.

**General Interest note:**
  REStats (Review of Economics and Statistics) is the most empirical of this group
  and particularly strong for labor/applied work. Journal of Economic Perspectives
  contains survey articles (no original data) — good for orientation, not for
  primary citation evidence.
`;
