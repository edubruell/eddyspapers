con <- DBI::dbConnect(duckdb::duckdb(), "data/db/articles.duckdb")
result <- DBI::dbGetQuery(con, "SELECT * FROM articles LIMIT 10")
DBI::dbDisconnect(con)
emit_section("Results", result)
