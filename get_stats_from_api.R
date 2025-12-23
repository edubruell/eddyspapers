library(tidyverse)
library(httr2)
library(eddyspapersbackend)
library(ipaddress)

get_stats_from_api <- function(days=1){
  request("https://econpapers.eduard-bruell.de/api/stats/searches") |>
    req_url_query(days = days) |>
    req_headers("X-API-Key" = Sys.getenv("EDDYPAPERS_API_KEY")) |> 
    req_perform() |> 
    resp_body_json()
}

get_day_tibble_from_api <- function(day = lubridate::today()){
  request("https://econpapers.eduard-bruell.de/api/dailylogs") |>
    req_url_query(day = day) |>
    req_headers("X-API-Key" = Sys.getenv("EDDYPAPERS_API_KEY")) |>
    req_perform() |>
    resp_body_json() |>
    purrr::map_dfr(tibble::as_tibble) |>
    dplyr::mutate(top3_handles = purrr::map_chr(top3_handles,1))
}

get_stats_from_api(30)

get_day_tibble_from_api("2025-12-23") |>
  distinct(timestamp,ip) |>
  count(ip) |>
  mutate(hostname = ip_address(ip) |> ip_to_hostname())


handles <- get_day_tibble_from_api("2025-12-22") |>
  dplyr::count(top3_handles) |>
  dplyr::pull(top3_handles)

sql <- paste0(
  "
  SELECT
    Handle,
    title,
    authors,
    journal,
    year,
    category,
    abstract
  FROM articles
  WHERE Handle IN (",
  paste(DBI::dbQuoteString(get_db_con(), handles), collapse = ","),
  ")
  "
)

top_papers_today <- DBI::dbGetQuery(get_db_con(), sql)

get_day_tibble_from_api("2025-12-22") |>
  filter(ip=="158.64.70.129") |>
  distinct(search_id,timestamp,Handle=top3_handles) |>
  left_join(top_papers_today,by = join_by(Handle)) |>
  View()






