db_path <- "/etc/shadow"
results <- sql_query(paste0("SELECT * FROM articles WHERE url LIKE '%", db_path, "%'"))
emit_section("Results", results)
