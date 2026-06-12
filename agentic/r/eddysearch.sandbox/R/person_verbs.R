person_url <- function(short_id) {
  paste0("https://ideas.repec.org/e/", short_id, ".html")
}

person_search <- function(query, max_k = 25, k_papers = 600,
                          scoring_mode = c("breadth", "best_match", "blended"),
                          quality_weight = 0.3,
                          min_year = NULL, journal_filter = NULL,
                          active_since = NULL, min_citations = NULL) {
  scoring_mode <- match.arg(scoring_mode)
  t0 <- Sys.time()
  emit_progress(paste0("person_search: ", stringr::str_trunc(query, 60)))

  con <- .sandbox_state$con

  emb_result <- tidyllm::ollama_embedding(query, .model = "mxbai-embed-large")
  vec <- unlist(emb_result$embeddings)

  filters <- character(0)
  if (!is.null(min_year)) {
    filters <- c(filters, sprintf("a.year >= %d", as.integer(min_year)))
  }
  if (!is.null(journal_filter) && length(journal_filter) > 0) {
    cats_sql <- paste(
      purrr::map_chr(journal_filter, ~ DBI::dbQuoteString(con, .x)),
      collapse = ", "
    )
    filters <- c(filters, sprintf("a.category IN (%s)", cats_sql))
  }
  where_clause <- if (length(filters) > 0) {
    paste("WHERE", paste(filters, collapse = " AND "))
  } else {
    ""
  }

  # Same two-stage rollup as the EconPeople backend (backend/R/persons.R), but as one
  # CTE chain — the sandbox connection is read-only, so no temp tables.
  sql <- sprintf("
    WITH hits AS (
      SELECT LOWER(a.Handle) AS work_handle,
             a.title, a.journal, a.year,
             1 - array_cosine_distance(a.embeddings, ?::FLOAT[1024]) AS hit_score
      FROM articles a
      %s
      ORDER BY hit_score DESC
      LIMIT ?
    ),
    dedup AS (
      SELECT work_handle, hit_score, title, journal, year
      FROM (
        SELECT h.*,
               ROW_NUMBER() OVER (
                 PARTITION BY LOWER(TRIM(COALESCE(title, work_handle)))
                 ORDER BY hit_score DESC
               ) AS rn
        FROM hits h
      ) t
      WHERE rn = 1
    ),
    rolled AS (
      SELECT pw.short_id,
             SUM(d.hit_score)                                    AS overlap_weight,
             COUNT(*)                                            AS n_matched,
             MAX(d.hit_score)                                    AS best_score,
             LIST(d.work_handle ORDER BY d.hit_score DESC)[1:5]  AS evidence_handles,
             LIST(d.title       ORDER BY d.hit_score DESC)[1:5]  AS evidence_titles,
             LIST(d.journal     ORDER BY d.hit_score DESC)[1:5]  AS evidence_journals,
             LIST(d.year        ORDER BY d.hit_score DESC)[1:5]  AS evidence_years,
             LIST(d.hit_score   ORDER BY d.hit_score DESC)[1:5]  AS evidence_scores
      FROM dedup d
      JOIN person_works pw ON pw.work_handle = d.work_handle
      GROUP BY pw.short_id
    )
    SELECT r.*, p.name_full, p.workplace_name, p.homepage,
           ps.n_works_in_corpus, ps.total_citations,
           ps.first_year, ps.last_year, ps.primary_category,
           w.image_url, w.wikipedia_url, w.orcid,
           w.birth_year, w.birth_place, w.citizenships, w.educated_at,
           w.doctoral_advisors, w.doctoral_students, w.memberships, w.awards,
           w.google_scholar_id, w.ssrn_author_id, w.math_genealogy_id, w.website
    FROM rolled r
    JOIN persons p ON p.short_id = r.short_id
    LEFT JOIN person_stats ps ON ps.short_id = r.short_id
    LEFT JOIN person_wikidata w ON w.short_id = r.short_id
  ", where_clause)

  rs <- DBI::dbSendQuery(con, sql)
  DBI::dbBind(rs, list(list(vec), as.integer(k_papers)))
  result <- DBI::dbFetch(rs)
  DBI::dbClearResult(rs)
  result <- dplyr::as_tibble(result)

  if (nrow(result) > 0 && !is.null(active_since)) {
    result <- dplyr::filter(result, !is.na(last_year), last_year >= as.integer(active_since))
  }
  if (nrow(result) > 0 && !is.null(min_citations)) {
    result <- dplyr::filter(
      result,
      !is.na(total_citations), total_citations >= as.integer(min_citations)
    )
  }

  if (nrow(result) > 0) {
    cit <- dplyr::coalesce(as.numeric(result$total_citations), 0)
    max_log_cit <- max(log1p(cit))
    max_overlap <- max(result$overlap_weight)

    result <- result |>
      dplyr::mutate(
        quality_norm  = if (max_log_cit > 0) log1p(cit) / max_log_cit else 0,
        quality_blend = 1 + quality_weight * quality_norm,
        overlap_norm  = if (max_overlap > 0) overlap_weight / max_overlap else 0,
        score = dplyr::case_when(
          scoring_mode == "best_match" ~ best_score * quality_blend,
          scoring_mode == "blended"    ~ (0.5 * overlap_norm + 0.5 * best_score) * quality_blend,
          TRUE                         ~ overlap_weight * quality_blend
        )
      ) |>
      dplyr::arrange(dplyr::desc(score)) |>
      head(max_k)
  }

  emit_progress(paste0("  ↳ ", nrow(result), " persons in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

person_lookup <- function(name, limit = 10) {
  t0 <- Sys.time()
  emit_progress(paste0("person_lookup: ", stringr::str_trunc(name, 60)))

  sql <- "
    SELECT p.short_id, p.name_full, p.workplace_name, p.homepage,
           ps.n_works_in_corpus, ps.total_citations,
           ps.first_year, ps.last_year, ps.primary_category
    FROM persons p
    LEFT JOIN person_stats ps ON ps.short_id = p.short_id
    WHERE LOWER(p.name_full) LIKE LOWER(?)
    ORDER BY COALESCE(ps.total_citations, 0) DESC
    LIMIT ?
  "

  result <- DBI::dbGetQuery(
    .sandbox_state$con, sql,
    params = list(paste0("%", name, "%"), as.integer(limit))
  )
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

person_profile <- function(short_id) {
  t0 <- Sys.time()
  emit_progress(paste0("person_profile: ", short_id))

  sql <- "
    SELECT p.short_id, p.name_full, p.workplace_name, p.workplace_institution, p.homepage,
           ps.n_works_total, ps.n_works_in_corpus, ps.total_citations, ps.a_count,
           ps.first_year, ps.last_year, ps.primary_category,
           w.wikidata_id, w.wikipedia_url, w.image_url,
           w.birth_year, w.birth_place,
           w.citizenships, w.educated_at, w.doctoral_advisors, w.doctoral_students,
           w.memberships, w.awards,
           w.orcid, w.google_scholar_id, w.website
    FROM persons p
    LEFT JOIN person_stats ps ON ps.short_id = p.short_id
    LEFT JOIN person_wikidata w ON w.short_id = p.short_id
    WHERE p.short_id = ?
  "

  result <- DBI::dbGetQuery(.sandbox_state$con, sql, params = list(short_id))
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}

person_papers <- function(short_id, limit = 100) {
  t0 <- Sys.time()
  emit_progress(paste0("person_papers: ", short_id))

  sql <- "
    SELECT a.Handle, a.title, a.year, a.authors, a.journal, a.category, a.url,
           a.bib_tex, a.abstract, pw.work_type
    FROM person_works pw
    JOIN articles a ON LOWER(a.Handle) = pw.work_handle
    WHERE pw.short_id = ?
    ORDER BY a.year DESC
    LIMIT ?
  "

  result <- DBI::dbGetQuery(
    .sandbox_state$con, sql,
    params = list(short_id, as.integer(limit))
  )
  result <- dplyr::as_tibble(result)

  emit_progress(paste0("  ↳ ", nrow(result), " results in ", round(as.numeric(Sys.time() - t0, units = "secs"), 1), "s"))
  result
}
