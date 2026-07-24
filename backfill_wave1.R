# M8 Wave 1 one-time backfill (localwip/notes/data_enrichment/00_plan.md).
#
# Populates the new enrichment data locally, writes patches for everything the
# server needs, applies the articles.doi patch locally, and resets the diff
# baseline. Run AFTER installing the updated eddyspapersbackend package.
#
#   Rscript backfill_wave1.R
#
# Then ship to prod with:  ./deploy_patches.sh
#
# The Crossref DOI backfill is separate and deliberate (build + calibrate
# first): see crossref_backfill() — sample run:
#   Rscript -e 'library(eddyspapersbackend); Sys.setenv(PAPER_SEARCH_DATA_ROOT="/Users/ebr/eddyspapers");
#               crossref_backfill(mailto = "eduard.bruell@zew.de", limit = 500)'

library(eddyspapersbackend)

Sys.setenv("PAPER_SEARCH_DATA_ROOT" = "/Users/ebr/eddyspapers")
config <- get_folder_config()
ensure_folders(config)
create_log_file(config)

db_path <- file.path(config$db_folder, "articles.duckdb")

info("==== M8 Wave 1 backfill ====")

info("\n[1/6] Migrating local schema...")
con <- get_db_con(db_path)
migrate_schema(con)

info("\n[2/6] Populating JEL tables locally...")
build_article_jel(con, rds_folder = config$rds_folder)
populate_jel_codes(con)

info("\n[3/6] Syncing + populating EDIRC institutions locally...")
sync_repec_edirc(dest_root = config$repec_folder)
institutions <- parse_all_institutions(repec_folder = config$repec_folder)
populate_institutions(con, institutions)

info("\n[4/6] Populating journal quality factors locally...")
populate_journal_quality(con)

DBI::dbDisconnect(con, shutdown = TRUE)

info("\n[4b/6] Re-parsing persons for workplace shares...")
# person_workplaces stays empty until persons_raw.rds is regenerated with the
# new workplaces element — one Perl pass over the already-synced pers archive.
parse_all_persons(
  repec_folder       = config$repec_folder,
  rds_persons_folder = config$rds_persons_folder
)
populate_persons(
  db_path            = db_path,
  rds_persons_folder = config$rds_persons_folder
)
con <- get_db_con(db_path)
compute_person_stats(con)
DBI::dbDisconnect(con, shutdown = TRUE)

info("\n[5/6] Writing patches for the server...")
# DOI: keyed column update against articles (embeddings untouched).
build_doi_patch(db_path = db_path)
# Side tables: full replaces — small, and their first server appearance can't
# ride the diff chain (absent from the base dump means the diff is skipped, and
# rows present in the post-backfill baseline dump can never re-appear as NEW).
con <- get_db_con(db_path, read_only = TRUE)
c("article_jel", "jel_codes", "institutions", "person_workplaces", "journal_quality") |>
  purrr::walk(function(tbl) {
    df <- DBI::dbGetQuery(con, sprintf("SELECT * FROM %s", tbl))
    write_patch(df, target_table = tbl, mode = "replace_table")
  })
DBI::dbDisconnect(con, shutdown = TRUE)

info("\n[6/6] Applying patches locally + resetting diff baseline...")
# run_backfill applies every pending patch (side-table replaces are no-op
# rewrites of identical data locally; the doi patch is the real change), then
# re-dumps so the next cron diff's base already contains everything.
run_backfill(db_path = db_path)

info("\n==== Wave 1 backfill complete ====")
info("Ship to prod with: ./deploy_patches.sh")
