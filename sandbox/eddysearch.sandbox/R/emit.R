emit_event <- function(payload_list) {
  if (is.null(.sandbox_state$fd3)) return(invisible(NULL))
  json_str <- jsonlite::toJSON(payload_list, auto_unbox = TRUE, null = "null")
  writeLines(json_str, con = .sandbox_state$fd3)
}

emit_progress <- function(label, current = NULL, total = NULL) {
  emit_event(list(type = "progress", label = label, current = current, total = total))
}

emit_note <- function(markdown) {
  emit_event(list(type = "note", markdown = markdown))
}

emit_bibtex <- function(handles) {
  .sandbox_state$bibtex_handles <- unique(c(.sandbox_state$bibtex_handles, handles))
  # I() keeps a length-1 vector a JSON array — auto_unbox would collapse it to a
  # scalar and the TS schema would drop the event.
  emit_event(list(type = "bibtex", handles = I(unique(.sandbox_state$bibtex_handles))))
}

.section_modes <- c("keyword", "semantic", "journal_scan", "author", "wp", "editor", "custom")

emit_section <- function(title, df, n = 25, note = NULL, mode = NULL) {
  if (is.null(mode)) {
    # Infer how the section was produced: semantic_search results carry a similarity
    # column; plain SQL/keyword results do not.
    mode <- if ("similarity" %in% names(df) && any(!is.na(df$similarity))) "semantic" else "keyword"
  }
  if (!mode %in% .section_modes) mode <- "custom"
  top_df <- head(df, n)

  # OpenAlex columns ride in from the data verbs (enrich_openalex) when the snapshot has them;
  # make_openalex_block reads them if present and is a no-op otherwise (custom-SQL sections,
  # pre-Track-B snapshots). emit_event serialises with null="null", so a NULL scalar becomes an
  # explicit JSON null (like similarity/doi today), which the TS paper schema tolerates via
  # nullable-optional; execute.ts then omits a null block from the Paper.
  na_null <- function(x) if (is.null(x) || length(x) == 0 || is.na(x)) NULL else x

  make_openalex_block <- function(row) {
    if (!"openalex_id" %in% names(row)) return(NULL)
    oid <- na_null(row$openalex_id)
    if (is.null(oid)) return(NULL) # a row exists only for matched works → id is the anchor
    list(
      openalex_id       = oid,
      oa_cited_by_count = na_null(row$oa_cited_by_count),
      fwci              = na_null(row$fwci),
      is_retracted      = na_null(row$is_retracted),
      is_oa             = na_null(row$is_oa),
      oa_url            = na_null(row$oa_url),
      oa_status         = na_null(row$oa_status),
      primary_topic     = na_null(row$primary_topic),
      primary_field     = na_null(row$primary_field)
    )
  }

  make_paper_event <- function(row) list(
    type       = "paper",
    handle     = row$Handle,
    title      = row$title,
    year       = row$year,
    authors    = row$authors,
    journal    = row$journal,
    category   = row$category,
    url        = paper_url(row$Handle, if ("url" %in% names(row)) row$url else NULL),
    similarity = if ("similarity" %in% names(row)) row$similarity else NULL,
    abstract   = if ("abstract" %in% names(row)) row$abstract else NULL,
    doi        = if ("doi" %in% names(row)) row$doi else NULL,
    openalex   = make_openalex_block(row)
  )

  purrr::walk(seq_len(nrow(top_df)), function(i) {
    h <- top_df$Handle[[i]]
    if (!h %in% .sandbox_state$seen_handles) {
      .sandbox_state$seen_handles <- c(.sandbox_state$seen_handles, h)
      emit_event(make_paper_event(top_df[i, , drop = FALSE]))
    }
  })

  emit_event(list(type = "section", title = title, handles = I(top_df$Handle), note = note, mode = mode))
}

emit_person_section <- function(title, df, n = 10, note = NULL) {
  top_df <- head(df, n)

  na_null <- function(x) {
    if (is.null(x) || length(x) == 0) return(NULL)
    x <- x[[1]]
    if (length(x) == 1 && is.na(x)) NULL else x
  }
  col <- function(row, name) if (name %in% names(row)) na_null(row[[name]]) else NULL

  # List-column cells (citizenships, advisors, students, ...) must stay JSON arrays:
  # I() blocks auto_unbox from collapsing a length-1 vector to a scalar.
  arr_col <- function(row, name) {
    if (!name %in% names(row)) return(NULL)
    x <- row[[name]]
    if (is.null(x) || length(x) == 0) return(NULL)
    x <- x[[1]]
    x <- x[!is.na(x)]
    if (length(x) == 0) return(NULL)
    I(x)
  }

  make_evidence <- function(row) {
    ev_cols <- c("evidence_handles", "evidence_titles", "evidence_journals",
                 "evidence_years", "evidence_scores")
    if (!all(ev_cols %in% names(row))) return(NULL)
    hs <- row$evidence_handles[[1]]
    if (is.null(hs) || length(hs) == 0) return(NULL)
    purrr::map(seq_along(hs), function(j) list(
      handle  = hs[[j]],
      title   = row$evidence_titles[[1]][[j]],
      journal = row$evidence_journals[[1]][[j]],
      year    = row$evidence_years[[1]][[j]],
      score   = row$evidence_scores[[1]][[j]]
    ))
  }

  make_person_event <- function(row) list(
    type             = "person",
    short_id         = row$short_id[[1]],
    name             = col(row, "name_full"),
    affiliation      = col(row, "workplace_name"),
    homepage         = col(row, "homepage"),
    image_url        = col(row, "image_url"),
    wikipedia_url    = col(row, "wikipedia_url"),
    orcid            = col(row, "orcid"),
    url              = person_url(row$short_id[[1]]),
    n_works          = col(row, "n_works_in_corpus"),
    citations        = col(row, "total_citations"),
    first_year       = col(row, "first_year"),
    last_year        = col(row, "last_year"),
    primary_category = col(row, "primary_category"),
    n_matched        = col(row, "n_matched"),
    birth_year        = col(row, "birth_year"),
    birth_place       = col(row, "birth_place"),
    citizenships      = arr_col(row, "citizenships"),
    educated_at       = arr_col(row, "educated_at"),
    doctoral_advisors = arr_col(row, "doctoral_advisors"),
    doctoral_students = arr_col(row, "doctoral_students"),
    memberships       = arr_col(row, "memberships"),
    awards            = arr_col(row, "awards"),
    google_scholar_id = col(row, "google_scholar_id"),
    ssrn_author_id    = col(row, "ssrn_author_id"),
    math_genealogy_id = col(row, "math_genealogy_id"),
    website           = col(row, "website"),
    evidence         = make_evidence(row)
  )

  purrr::walk(seq_len(nrow(top_df)), function(i) {
    sid <- top_df$short_id[[i]]
    if (!sid %in% .sandbox_state$seen_persons) {
      .sandbox_state$seen_persons <- c(.sandbox_state$seen_persons, sid)
      emit_event(make_person_event(top_df[i, , drop = FALSE]))
    }
  })

  emit_event(list(type = "person_section", title = title, short_ids = I(top_df$short_id), note = note))
}
