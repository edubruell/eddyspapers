library(eddyspapersbackend)

config <- get_folder_config()

message("Starting Semantic Paper Search API")
message("Data root: ", config$data_root)
message("Database: ", file.path(config$db_folder, "articles.duckdb"))

run_plumber_api(
  host = "0.0.0.0",
  port = 8000,
  max_connections = 5
)
