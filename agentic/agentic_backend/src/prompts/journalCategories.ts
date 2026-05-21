export const journalCategoriesPrompt = `\
## Journal categories in the database

The category field in the articles table uses these tier labels. Use them in journal_filter
to restrict semantic_search to quality tiers. Multiple tiers can be combined as a vector.

| Category label   | Representative journals                                                                  |
|-----------------|------------------------------------------------------------------------------------------|
| Top 5           | American Economic Review, Quarterly Journal of Economics, Journal of Political Economy,  |
|                 | Econometrica, Review of Economic Studies                                                 |
| AEJ             | AEJ: Applied Economics, AEJ: Macroeconomics, AEJ: Economic Policy, AEJ: Microeconomics  |
| Top Field A     | Journal of Labor Economics, Journal of Public Economics, Journal of Monetary Economics,  |
|                 | Journal of International Economics, Journal of Development Economics, Journal of Finance,|
|                 | Journal of Financial Economics, Review of Financial Studies, Journal of Economic Theory, |
|                 | Journal of Environmental Economics and Management, RAND Journal of Economics,            |
|                 | Journal of Health Economics, Journal of Human Resources, Journal of Urban Economics      |
| General Interest| Economic Journal, Review of Economics and Statistics, Journal of Economic Perspectives,  |
|                 | Oxford Economic Papers, Scandinavian Journal of Economics, Canadian Journal of Economics,|
|                 | European Economic Review, Journal of the European Economic Association,                  |
|                 | Journal of Economic Behavior & Organization, Economica, Oxford Bulletin of Economics     |
| Top Field B     | Second-tier field journals: Labour Economics, Journal of Economic Dynamics and Control,  |
|                 | International Economic Review, Economics Letters, Journal of Macroeconomics,             |
|                 | Journal of Banking & Finance, Journal of Policy Analysis and Management,                 |
|                 | Journal of Population Economics, Economics of Education Review                           |
| Other           | Further peer-reviewed journals not in the tiers above                                    |
| Working Paper   | NBER Working Papers, IZA Discussion Papers, CESifo Working Papers, ZEW Discussion Papers,|
|                 | DIW Discussion Papers, Bundesbank Discussion Papers, ECB Working Papers, CEPR DP series, |
|                 | Federal Reserve Bank working papers, SSRN preprints                                     |

### Notes on tier selection

**For published-work quality filters:**
  c("Top 5", "AEJ", "Top Field A")   — top-tier journals only (high confidence, smaller set)
  c("Top 5", "AEJ", "Top Field A", "General Interest")  — add second-tier general journals
  c("Top 5", "AEJ", "Top Field A", "General Interest", "Top Field B")  — broad sweep

**For working papers specifically:**
  journal_filter = c("Working Paper")  — all preprint series
  Use min_year = 2019L to focus on recent WPs; avoid combining WP with published tiers
  in one call (better to run separate sections for WPs and published work).

**Working Paper series coverage:**
  NBER (~85k), IZA (~15k), CESifo (~10k), ZEW (~5k), DIW, Bundesbank, ECB, CEPR.
  The series overlap significantly with published versions — use versions() to find
  the journal version of a given WP handle if needed.

**General Interest note:**
  REStats (Review of Economics and Statistics) is the most empirical of this group
  and particularly strong for labor/applied work. Journal of Economic Perspectives
  contains survey articles (no original data) — good for orientation, not for
  primary citation evidence.
`;
