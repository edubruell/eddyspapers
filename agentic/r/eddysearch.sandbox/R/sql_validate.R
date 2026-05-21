validate_sql <- function(sql, con) {
  escaped_sql <- gsub("'", "''", sql)
  tree_str <- DBI::dbGetQuery(con, paste0("SELECT json_serialize_sql('", escaped_sql, "') AS tree"))$tree
  parsed <- jsonlite::fromJSON(tree_str, simplifyVector = FALSE)

  if (isTRUE(parsed$error)) {
    stop("Only SELECT queries are allowed.")
  }

  node_type <- parsed$statements[[1]]$node$type
  if (length(node_type) == 0 || !node_type %in% c("SELECT_NODE", "SET_OPERATION_NODE")) {
    stop("Only SELECT queries are allowed.")
  }

  blocked_fns <- c(
    "read_csv", "read_csv_auto", "read_parquet", "read_json", "read_json_auto",
    "read_blob", "glob", "parquet_scan", "parquet_metadata", "parquet_schema",
    "sniff_csv", "sql_auto_complete", "query_table", "read_text", "read_ndjson",
    "getvariable", "setvariable"
  )

  allowed_tables <- c(
    "articles", "cit_all", "cit_internal", "handle_stats",
    "journals", "versions", "bib_coupling"
  )

  walk_node <- function(node) {
    if (!is.list(node)) return(invisible(NULL))

    node_t <- node$type

    if (identical(node_t, "TABLE_FUNCTION")) {
      fn_node <- node[["function"]]
      if (!is.null(fn_node) && !is.null(fn_node$function_name)) {
        fn_name <- tolower(fn_node$function_name)
        if (fn_name %in% blocked_fns) {
          stop(paste0("Blocked function: ", fn_name))
        }
      }
    }

    if (identical(node_t, "FUNCTION") || identical(node_t, "FUNCTION_NODE")) {
      fn_name <- tolower(node$function_name)
      if (!is.null(fn_name) && fn_name %in% blocked_fns) {
        stop(paste0("Blocked function: ", fn_name))
      }
    }

    if (identical(node_t, "BASE_TABLE") || identical(node_t, "BASE_TABLE_REF")) {
      schema_name <- node$schema_name
      tbl_name <- tolower(node$table_name)
      if (!is.null(schema_name) && nchar(schema_name) > 0) {
        stop(paste0("Table not in allowlist: ", schema_name, ".", tbl_name))
      }
      if (!is.null(tbl_name) && !tbl_name %in% allowed_tables) {
        stop(paste0("Table not in allowlist: ", tbl_name))
      }
    }

    purrr::walk(node, function(child) {
      if (is.list(child)) walk_node(child)
    })
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

  if (has_outer_limit) sql else paste0(sql, " LIMIT 5000")
}
