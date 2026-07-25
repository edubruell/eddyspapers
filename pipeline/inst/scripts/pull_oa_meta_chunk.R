# Watchdog worker for pull_openalex_metrics(): execute one chunk's COPY.
# Args: <sql_file> <out.parquet> <threads>
# Deliberately package-free (only DBI + duckdb, which are always installed) so
# it starts fast and works under devtools::load_all. The parent owns all SQL:
# sql_file holds the full COPY (built by oa_meta_copy_sql) writing to out.tmp;
# on success we atomically rename to out so the parent's watchdog detects
# completion and can abandon a stalled worker without waiting for its reap.
a <- commandArgs(trailingOnly = TRUE)
sql_file <- a[[1]]; out <- a[[2]]; threads <- as.integer(a[[3]])
library(DBI)
con <- dbConnect(duckdb::duckdb())
dbExecute(con, "INSTALL httpfs; LOAD httpfs;")
dbExecute(con, "SET s3_region='us-east-1';")
dbExecute(con, "SET http_timeout=30000; SET http_retries=3;")
dbExecute(con, sprintf("SET threads=%d;", threads))
try(dbExecute(con, "CREATE SECRET oa (TYPE s3, PROVIDER config, KEY_ID '', SECRET '');"),
    silent = TRUE)
dbExecute(con, paste(readLines(sql_file), collapse = "\n"))
dbDisconnect(con, shutdown = TRUE)
file.rename(paste0(out, ".tmp"), out)
cat("OK\n")
