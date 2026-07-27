validate_sql <- function(sql, con) {
  escaped_sql <- gsub("'", "''", sql)
  tree_str <- DBI::dbGetQuery(con, paste0("SELECT json_serialize_sql('", escaped_sql, "') AS tree"))$tree
  parsed <- jsonlite::fromJSON(tree_str, simplifyVector = FALSE)

  if (isTRUE(parsed$error)) {
    stop("Only SELECT queries are allowed.")
  }

  # A trailing `; DROP …` / `; SELECT … secret` serialises as extra statements, and only
  # the first was ever validated — reject anything but a single statement.
  if (length(parsed$statements) != 1) {
    stop("Only a single SELECT statement is allowed.")
  }

  node_type <- parsed$statements[[1]]$node$type
  if (length(node_type) == 0 || !node_type %in% c("SELECT_NODE", "SET_OPERATION_NODE")) {
    stop("Only SELECT queries are allowed.")
  }

  blocked_fns <- c(
    # file / blob / text readers
    "read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto",
    "read_blob", "read_text", "read_ndjson", "read_xlsx", "glob",
    "parquet_scan", "parquet_metadata", "parquet_schema", "parquet_file_metadata",
    "sniff_csv", "sql_auto_complete", "query_table", "query",
    "getvariable", "setvariable", "getenv",
    # external data sources / ATTACH-style scanners
    "sqlite_scan", "sqlite_attach", "postgres_scan", "postgres_scan_pushdown",
    "postgres_attach", "postgres_query", "postgres_execute",
    "mysql_scan", "mysql_attach", "mysql_query", "mysql_execute",
    "iceberg_scan", "iceberg_metadata", "iceberg_snapshots", "delta_scan",
    "st_read", "st_read_meta", "shapefile_meta",
    # settings / secrets / catalog introspection that leak host state
    "duckdb_settings", "current_setting", "pragma_database_list", "pragma_database_size",
    "duckdb_secrets", "which_secret", "duckdb_extensions", "load_aws_credentials"
  )

  allowed_tables <- c(
    "articles", "cit_all", "cit_internal", "handle_stats",
    "journals", "version_links", "bib_coupling",
    "persons", "person_works", "person_stats", "person_wikidata",
    "article_jel", "jel_codes", "institutions", "person_workplaces",
    "journal_quality"
  )

  # CTE aliases (`WITH x AS (...)`) serialise as BASE_TABLE refs, so a reference to `x`
  # would otherwise fail the table allowlist. Collect every CTE name in the tree and add
  # it to the allowlist. The CTE *bodies* are still walked and validated below, so a CTE
  # that selects from a disallowed table is still rejected.
  collect_cte_names <- function(node, acc = character(0)) {
    if (!is.list(node)) return(acc)
    cte_entries <- node$cte_map$map
    if (!is.null(cte_entries)) {
      for (entry in cte_entries) {
        if (length(entry$key) == 1) acc <- c(acc, tolower(entry$key))
      }
    }
    for (child in node) if (is.list(child)) acc <- collect_cte_names(child, acc)
    acc
  }
  allowed_tables <- c(allowed_tables, collect_cte_names(parsed$statements[[1]]$node))

  walk_node <- function(node) {
    if (!is.list(node)) return(invisible(NULL))

    node_t <- node$type

    if (identical(node_t, "TABLE_FUNCTION")) {
      fn_node <- node[["function"]]
      if (!is.null(fn_node)) {
        fn_name <- tolower(fn_node$function_name)
        if (length(fn_name) == 1 && fn_name %in% blocked_fns) {
          stop(paste0("Blocked function: ", fn_name))
        }
      }
    }

    if (identical(node_t, "FUNCTION") || identical(node_t, "FUNCTION_NODE")) {
      fn_name <- tolower(node$function_name)
      if (length(fn_name) == 1 && fn_name %in% blocked_fns) {
        stop(paste0("Blocked function: ", fn_name))
      }
    }

    if (identical(node_t, "BASE_TABLE") || identical(node_t, "BASE_TABLE_REF")) {
      schema_name <- node$schema_name
      tbl_name <- tolower(node$table_name)
      if (length(schema_name) == 1 && nchar(schema_name) > 0) {
        stop(paste0("Table not in allowlist: ", schema_name, ".", tbl_name))
      }
      if (length(tbl_name) == 1 && !tbl_name %in% allowed_tables) {
        stop(paste0("Table not in allowlist: ", tbl_name))
      }
    }

    # Base loop, not purrr::walk: a rejection stop() should propagate with its own message,
    # not get wrapped in rlang's "ℹ In index: N / Caused by error in map()" chain.
    for (child in node) {
      if (is.list(child)) walk_node(child)
    }
  }

  walk_node(parsed$statements[[1]]$node)

  invisible(TRUE)
}

inject_limit <- function(sql, con = NULL) {
  has_outer_limit <- if (!is.null(con)) {
    escaped <- gsub("'", "''", sql)
    tree_str <- DBI::dbGetQuery(con, paste0("SELECT json_serialize_sql('", escaped, "') AS tree"))$tree
    parsed <- jsonlite::fromJSON(tree_str, simplifyVector = FALSE)
    if (isTRUE(parsed$error)) {
      FALSE
    } else {
      modifiers <- parsed$statements[[1]]$node$modifiers
    if (is.null(modifiers)) modifiers <- list()
      any(purrr::map_lgl(modifiers, ~ identical(.x$type, "LIMIT_MODIFIER")))
    }
  } else {
    grepl("\\bLIMIT\\b", toupper(sql))
  }

  # Wrap rather than append: `paste0(sql, " LIMIT 5000")` lands the cap inside a trailing
  # `-- comment`, defeating it. Wrapping in a subquery caps the row count no matter what
  # trails the inner query — the newline before `)` ends any trailing line comment so the
  # cap stays live. (validate_sql has already rejected multi-statements and unterminated
  # block comments, so no other trailing construct can swallow the wrapper.)
  if (has_outer_limit) sql else paste0("SELECT * FROM (\n", sql, "\n) AS __sandbox_lim LIMIT 5000")
}
