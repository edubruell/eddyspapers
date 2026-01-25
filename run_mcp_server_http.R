#!/usr/bin/env Rscript

library(eddyspapersbackend)

api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)

if (is.na(api_key)) {
  stop("EDDYPAPERS_API_KEY environment variable must be set")
}

port <- as.integer(Sys.getenv("MCPTOOLS_PORT", "8085"))

message("Starting Eddy's Papers MCP Server (HTTP)...")
message("API Key found: ", substr(api_key, 1, 8), "...")
message("Using API URL: ", Sys.getenv("EDDYPAPERS_API_URL",
        "https://econpapers.eduard-bruell.de/api"))
message("Listening on port: ", port)

start_eddypapers_mcp(
  type = "http",
  host = "127.0.0.1",
  port = port,
  session_tools = FALSE
)
