#' Keyed column patches: parquet + manifest dumps for backfills
#'
#' A patch transports targeted changes (new-column backfills, small-table
#' replaces) to any copy of the corpus DB without moving full article rows —
#' the diff chain ships whole rows including embeddings, which makes it the
#' wrong vehicle for enrichment backfills (see
#' localwip/notes/data_enrichment/01_backfill_mechanism.md).
#'
#' On-disk format in config$pqt_patch_folder:
#'   {patch_id}.parquet        — key columns + payload columns
#'   {patch_id}.manifest.json  — target_table, key_cols, payload_cols, mode
#'
#' Modes:
#'   update_columns — UPDATE target SET payload FROM patch WHERE keys match
#'   upsert_rows    — DELETE matching keys, INSERT patch rows
#'   replace_table  — CREATE OR REPLACE TABLE target AS SELECT * FROM patch

patch_modes <- c("update_columns", "upsert_rows", "replace_table")

# Parquet I/O through DuckDB itself — the arrow R package hard-crashes on
# write in this project's library (ABI clash with duckdb), and DuckDB COPY is
# what the dump path already uses.
write_parquet_df <- function(df, path) {
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  duckdb::duckdb_register(con, "df_out", df)
  path_norm <- normalizePath(path, winslash = "/", mustWork = FALSE)
  DBI::dbExecute(con, sprintf(
    "COPY (SELECT * FROM df_out) TO '%s' (FORMAT PARQUET)", path_norm
  ))
  invisible(path)
}

read_parquet_df <- function(path) {
  con <- DBI::dbConnect(duckdb::duckdb())
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  path_norm <- normalizePath(path, winslash = "/", mustWork = TRUE)
  tibble::as_tibble(DBI::dbGetQuery(con, sprintf(
    "SELECT * FROM read_parquet('%s')", path_norm
  )))
}

#' Write a patch (parquet + manifest)
#'
#' @param df Data frame with key + payload columns
#' @param target_table Table the patch applies to
#' @param key_cols Character vector of key column names (ignored for replace_table)
#' @param mode One of update_columns, upsert_rows, replace_table
#' @param patch_id Unique id; becomes the filename and the applied-record key.
#'   Defaults to {target_table}_{mode}_{timestamp}.
#' @param pqt_patch_folder Output folder. Defaults to config$pqt_patch_folder
#' @return Path to the manifest file (invisibly)
#' @export
write_patch <- function(df,
                        target_table,
                        key_cols = character(0),
                        mode = c("update_columns", "upsert_rows", "replace_table"),
                        patch_id = NULL,
                        pqt_patch_folder = NULL) {
  mode <- match.arg(mode)

  if (is.null(pqt_patch_folder)) {
    config <- get_folder_config()
    pqt_patch_folder <- config$pqt_patch_folder
  }
  if (!dir.exists(pqt_patch_folder)) {
    dir.create(pqt_patch_folder, recursive = TRUE, showWarnings = FALSE)
  }

  if (mode != "replace_table") {
    missing_keys <- setdiff(key_cols, colnames(df))
    if (length(key_cols) == 0) stop("key_cols required for mode ", mode)
    if (length(missing_keys) > 0) {
      stop("key_cols missing from patch data: ", paste(missing_keys, collapse = ", "))
    }
    if (anyDuplicated(df[key_cols])) {
      stop("Patch keys are not unique in ", target_table, " patch")
    }
  }

  if (is.null(patch_id)) {
    patch_id <- paste0(target_table, "_", mode, "_", format(Sys.time(), "%Y%m%d_%H%M%S"))
  }

  payload_cols <- setdiff(colnames(df), key_cols)
  if (mode == "update_columns" && length(payload_cols) == 0) {
    stop("update_columns patch has no payload columns")
  }

  parquet_path  <- file.path(pqt_patch_folder, paste0(patch_id, ".parquet"))
  manifest_path <- file.path(pqt_patch_folder, paste0(patch_id, ".manifest.json"))

  write_parquet_df(df, parquet_path)
  jsonlite::write_json(
    list(
      patch_id     = patch_id,
      target_table = target_table,
      key_cols     = key_cols,
      payload_cols = payload_cols,
      mode         = mode,
      created      = format(Sys.time(), "%Y-%m-%dT%H:%M:%S%z"),
      rows         = nrow(df)
    ),
    manifest_path,
    auto_unbox = TRUE,
    pretty = TRUE
  )

  info("Wrote patch ", patch_id, " (", mode, " on ", target_table, ", ", nrow(df), " rows)")
  invisible(manifest_path)
}

read_patch_manifest <- function(manifest_path) {
  m <- jsonlite::read_json(manifest_path, simplifyVector = TRUE)
  required <- c("patch_id", "target_table", "mode")
  missing <- required[!required %in% names(m)]
  if (length(missing) > 0) {
    stop("Patch manifest ", manifest_path, " missing fields: ", paste(missing, collapse = ", "))
  }
  if (!m$mode %in% patch_modes) stop("Unknown patch mode: ", m$mode)
  # target_table is interpolated into SQL (replace_table has no DESCRIBE-based
  # column check to constrain it) and patch_id becomes a file path — both must
  # be plain identifiers, not statement or path fragments.
  if (!grepl("^[A-Za-z_][A-Za-z0-9_]*$", m$target_table)) {
    stop("Patch manifest ", manifest_path, " has a non-identifier target_table")
  }
  if (!grepl("^[A-Za-z0-9_.-]+$", m$patch_id) || grepl("\\.\\.", m$patch_id)) {
    stop("Patch manifest ", manifest_path, " has an unsafe patch_id")
  }
  m$key_cols     <- as.character(m$key_cols %||% character(0))
  m$payload_cols <- as.character(m$payload_cols %||% character(0))
  m
}

ensure_patch_meta <- function(con) {
  DBI::dbExecute(con, "
    CREATE TABLE IF NOT EXISTS patch_meta (
      patch_id   VARCHAR PRIMARY KEY,
      applied_at TIMESTAMP
    )
  ")
}

#' Apply a single patch to a database
#'
#' Runs migrate_schema first, validates the manifest against the live schema,
#' applies inside a transaction, and records the patch_id in patch_meta.
#' Already-applied patches are skipped (idempotent re-runs).
#'
#' @param con DuckDB connection (read-write)
#' @param manifest_path Path to the {patch_id}.manifest.json file
#' @return TRUE if applied, FALSE if skipped as already applied (invisibly)
#' @export
apply_patch <- function(con, manifest_path) {
  m <- read_patch_manifest(manifest_path)
  parquet_path <- file.path(dirname(manifest_path), paste0(m$patch_id, ".parquet"))
  if (!file.exists(parquet_path)) stop("Patch parquet not found: ", parquet_path)

  migrate_schema(con)
  ensure_patch_meta(con)

  already <- DBI::dbGetQuery(
    con, "SELECT COUNT(*) AS n FROM patch_meta WHERE patch_id = ?",
    params = list(m$patch_id)
  )$n > 0
  if (already) {
    info("Patch ", m$patch_id, " already applied — skipping")
    return(invisible(FALSE))
  }

  table_exists <- m$target_table %in% DBI::dbListTables(con)
  if (!table_exists && m$mode != "replace_table") {
    stop("Patch ", m$patch_id, " targets missing table ", m$target_table)
  }
  patch_cols <- c(m$key_cols, m$payload_cols)
  if (table_exists && m$mode != "replace_table") {
    target_cols <- DBI::dbGetQuery(
      con, sprintf("DESCRIBE %s", m$target_table)
    )$column_name
    unknown <- setdiff(patch_cols, target_cols)
    if (length(unknown) > 0) {
      stop("Patch ", m$patch_id, " references columns not in ", m$target_table,
           ": ", paste(unknown, collapse = ", "))
    }
  }

  pq <- normalizePath(parquet_path, winslash = "/", mustWork = TRUE)
  info("Applying patch ", m$patch_id, " (", m$mode, " on ", m$target_table, ", ",
       m$rows %||% "?", " rows)")

  DBI::dbExecute(con, "BEGIN TRANSACTION")
  ok <- tryCatch({
    if (m$mode == "update_columns") {
      set_clause <- paste(
        sprintf("%s = p.%s", m$payload_cols, m$payload_cols),
        collapse = ", "
      )
      join_clause <- paste(
        sprintf("%s.%s = p.%s", m$target_table, m$key_cols, m$key_cols),
        collapse = " AND "
      )
      n <- DBI::dbExecute(con, sprintf(
        "UPDATE %s SET %s FROM read_parquet('%s') p WHERE %s",
        m$target_table, set_clause, pq, join_clause
      ))
      info("  Updated ", n, " rows")
    } else if (m$mode == "upsert_rows") {
      key_tuple <- paste(m$key_cols, collapse = ", ")
      DBI::dbExecute(con, sprintf(
        "DELETE FROM %s WHERE (%s) IN (SELECT %s FROM read_parquet('%s'))",
        m$target_table, key_tuple, key_tuple, pq
      ))
      cols <- paste(patch_cols, collapse = ", ")
      n <- DBI::dbExecute(con, sprintf(
        "INSERT INTO %s (%s) SELECT %s FROM read_parquet('%s')",
        m$target_table, cols, cols, pq
      ))
      info("  Upserted ", n, " rows")
    } else {
      DBI::dbExecute(con, sprintf(
        "CREATE OR REPLACE TABLE %s AS SELECT * FROM read_parquet('%s')",
        m$target_table, pq
      ))
      info("  Replaced table ", m$target_table)
    }
    DBI::dbExecute(
      con, "INSERT INTO patch_meta (patch_id, applied_at) VALUES (?, ?)",
      params = list(m$patch_id, Sys.time())
    )
    DBI::dbExecute(con, "COMMIT")
    TRUE
  }, error = function(e) {
    DBI::dbExecute(con, "ROLLBACK")
    stop("Patch ", m$patch_id, " failed (rolled back): ", conditionMessage(e))
  })

  # replace_table drops indices with the old table — restore the standard ones.
  if (m$mode == "replace_table") migrate_schema(con)

  invisible(ok)
}

#' Apply all pending patches in a folder
#'
#' Applies every manifest in patch_id (= filename) order, skipping ones already
#' recorded in patch_meta. This is what server_apply_patch.R calls.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @param pqt_patch_folder Patch folder. Defaults to config$pqt_patch_folder
#' @return Character vector of applied patch ids (invisibly)
#' @export
apply_all_patches <- function(db_path = NULL, pqt_patch_folder = NULL) {
  if (is.null(db_path)) {
    config <- get_folder_config()
    db_path <- file.path(config$db_folder, "articles.duckdb")
  }
  if (is.null(pqt_patch_folder)) {
    config <- get_folder_config()
    pqt_patch_folder <- config$pqt_patch_folder
  }

  manifests <- sort(list.files(
    pqt_patch_folder, pattern = "\\.manifest\\.json$", full.names = TRUE
  ))
  if (length(manifests) == 0) {
    info("No patches found in ", pqt_patch_folder)
    return(invisible(character(0)))
  }

  con <- get_db_con(db_path)
  on.exit(DBI::dbDisconnect(con, shutdown = TRUE), add = TRUE)
  DBI::dbExecute(con, "SET hnsw_enable_experimental_persistence=true;")

  applied <- purrr::keep(manifests, ~apply_patch(con, .x)) |>
    purrr::map_chr(~read_patch_manifest(.x)$patch_id)

  DBI::dbExecute(con, "CHECKPOINT")
  info("Applied ", length(applied), " patch(es)")
  invisible(applied)
}

#' Run a local backfill end-to-end (patch apply + baseline reset)
#'
#' Enforces the ordering rule from the design doc: apply the patch locally,
#' then IMMEDIATELY re-dump to parquet so the next cron diff's base already
#' contains the backfill — otherwise the whole backfill re-ships as an
#' embedding-laden article diff. Server deploy stays a separate, explicit step
#' (deploy_patches.sh) so local experiments don't touch prod.
#'
#' @param db_path Path to DuckDB database. Defaults to config$db_folder/articles.duckdb
#' @return Applied patch ids (invisibly)
#' @export
run_backfill <- function(db_path = NULL) {
  applied <- apply_all_patches(db_path = db_path)
  if (length(applied) > 0) {
    info("Resetting diff baseline (dump_db_to_parquet)...")
    dump_db_to_parquet(db_path = db_path)
    # After the baseline reset the diff chain can NEVER re-detect these changes
    # — if the patch deploy is skipped, prod silently diverges forever.
    warn("Baseline reset done. These patches MUST now ship to prod via ./deploy_patches.sh: ",
         paste(applied, collapse = ", "))
  }
  invisible(applied)
}
