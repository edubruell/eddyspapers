#!/usr/bin/env Rscript

library(eddyspapersbackend)

api_key <- Sys.getenv("EDDYPAPERS_API_KEY", unset = NA)

if (is.na(api_key)) {
  stop("EDDYPAPERS_API_KEY environment variable must be set")
}

message("Starting Eddy's Papers MCP Server...")
message("API Key found: ", substr(api_key, 1, 8), "...")
message("Using API URL: ", Sys.getenv("EDDYPAPERS_API_URL",
        "https://econpapers.eduard-bruell.de/api"))

start_eddypapers_mcp(type = "stdio", session_tools = FALSE)
