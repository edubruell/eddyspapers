library(tidyverse)
library(eddyspapersbackend)
library(httr2)


#Enrich an IP with online data from the ripe.net API endpoint
enrich_ip <- function(ip) {
  Sys.sleep(0.3)  # ~200/min compliance
  
  glue::glue("https://stat.ripe.net/data/whois/data.json") |>
    request() |>
    req_url_query(resource = ip) |>
    req_retry(max_tries = 3) |>
    req_user_agent("IP-Enricher/1.0") |>
    req_perform() |>
    resp_body_json()
}

#enrich wigth caching to a file of kown IPs
enrich_ip_cached <- function(ips,
                             ip_cache_file = "stats/ip_enrichment_cache.rds") {
  
  # Initialize cache if file doesn't exist
  if (!file.exists(ip_cache_file)) {
    message("Creating new cache file: ", ip_cache_file)
    dir.create(dirname(ip_cache_file), showWarnings = FALSE, recursive = TRUE)
    ip_cache <- tibble(
      ip = character(),
      ripe_data = list(),
      fetched_at = as.POSIXct(character()),
      error = logical()
    )
    saveRDS(ip_cache, ip_cache_file)
  } else {
    ip_cache <- readRDS(ip_cache_file)
  }
  
  new_ips <- setdiff(ips, ip_cache$ip)
  
  if (length(new_ips) > 0) {
    message("Fetching ", length(new_ips), " new IPs...")
    
    ip_cache <- reduce(new_ips, function(cache, ip) {
      result <- tryCatch({
        ripe_response <- enrich_ip(ip)
        tibble(
          ip = ip,
          ripe_data = list(ripe_response),
          fetched_at = Sys.time(),
          error = FALSE
        )
      }, error = function(e) {
        warning("Failed to fetch IP: ", ip, " - ", e$message)
        tibble(
          ip = ip,
          ripe_data = list(NULL),
          fetched_at = Sys.time(),
          error = TRUE
        )
      })
      
      updated_cache <- bind_rows(cache, result)
      saveRDS(updated_cache, ip_cache_file)
      updated_cache
    }, .init = ip_cache)
  }
  
  ip_cache
}

# Unified field extractor that handles both RIPE and ARIN formats
extract_whois_field <- function(ripe_data, field_name) {
  if (is.null(ripe_data)) return(NA_character_)
  
  # Try both lowercase (RIPE) and capitalized (ARIN) field names
  field_variants <- c(
    field_name,
    paste0(toupper(substring(field_name, 1, 1)), substring(field_name, 2))
  )
  
  records <- ripe_data$data$records
  if (length(records) == 0) return(NA_character_)
  
  # Search through all record blocks (ARIN can have multiple)
  for (record_block in records) {
    values <- record_block |>
      keep(~ .x$key %in% field_variants) |>
      map_chr(~ .x$value)
    
    if (length(values) > 0) {
      result <- paste(values, collapse = "; ")
      return(result)
    }
  }
  
  NA_character_
}

# Specific extractors with fallback logic
extract_netname <- function(ripe_data) {
  # Try NetName first (ARIN), then netname (RIPE)
  result <- extract_whois_field(ripe_data, "NetName")
  if (is.na(result)) {
    result <- extract_whois_field(ripe_data, "netname")
  }
  result
}

extract_org_name <- function(ripe_data) {
  if (is.null(ripe_data)) return(NA_character_)
  
  records <- ripe_data$data$records
  if (length(records) == 0) return(NA_character_)
  
  registry <- ripe_data$data$authorities[[1]] %||% NA_character_
  
  if (registry == "arin") {
    # ARIN logic (same as before)
    for (record_block in records) {
      org_name <- record_block |>
        keep(~ .x$key == "OrgName") |>
        map_chr(~ .x$value)
      
      if (length(org_name) > 0) {
        org_name <- org_name[!grepl("Various Registries|American Registry|ARIN", org_name, ignore.case = TRUE)]
        if (length(org_name) > 0) return(org_name[1])
      }
    }
  } else {
    # For RIPE: Try main record first
    if (length(records) > 0) {
      descr_values <- records[[1]] |>
        keep(~ .x$key == "descr") |>
        map_chr(~ .x$value)
      
      if (length(descr_values) > 0) {
        return(paste(descr_values, collapse = "; "))
      }
    }
    
    # Fallback to irr_records if no descr in main record
    irr_records <- ripe_data$data$irr_records
    if (length(irr_records) > 0) {
      descr_values <- irr_records[[1]] |>
        keep(~ .x$key == "descr") |>
        map_chr(~ .x$value)
      
      if (length(descr_values) > 0) {
        return(paste(descr_values, collapse = "; "))
      }
    }
  }
  
  NA_character_
}

extract_country <- function(ripe_data) {
  # Country (ARIN) or country (RIPE)
  result <- extract_whois_field(ripe_data, "Country")
  if (is.na(result)) {
    result <- extract_whois_field(ripe_data, "country")
  }
  result
}

extract_cidr <- function(ripe_data) {
  # Get network range
  result <- extract_whois_field(ripe_data, "CIDR")
  if (is.na(result)) {
    result <- extract_whois_field(ripe_data, "inetnum")
  }
  result
}


# Your existing functions
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
    dplyr::mutate(top3_handles = purrr::map_chr(top3_handles,1),
                  day = day)
}

get_stats_from_api(40)

day_tibble <- get_day_tibble_from_api("2026-01-22") |>
  distinct(day,timestamp, ip) |>
  count(day,ip)


enrichment_data <- enrich_ip_cached(unique(day_tibble$ip))  |>
  filter(!error) |>
  mutate(
    registry = map_chr(ripe_data, ~ .x$data$authorities[[1]] %||% NA_character_),
    netname = map_chr(ripe_data, extract_netname),
    org_name = map_chr(ripe_data, extract_org_name),
    country = map_chr(ripe_data, extract_country),
  ) 

day_tibble |>
  left_join(enrichment_data |>
  select(ip,netname,org_name,country), by="ip") |>
  arrange(desc(n)) |>
  print(n=Inf)


enrichment_data |>
  distinct(netname,org_name,country) |>
  print(n=Inf)


get_day_tibble_from_api("2026-01-21") |>
  filter(ip == "130.44.118.136") |>
  select(search_id,top3_handles) |>
  print(n=Inf)








get_day_tibble_from_api("2026-01-22") |>
  distinct(timestamp,ip) |>
  count(ip) |>
  mutate(hostname = ip_address(ip) |> ip_to_hostname()) |>
  left_join(known_ips) |>
  print(n=Inf)




known_ips |>
  print(n=Inf)

handles <- get_day_tibble_from_api("2026-01-20") |>
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

get_day_tibble_from_api("2026-01-19") |>
  distinct(search_id,timestamp,Handle=top3_handles) |>
  left_join(top_papers_today,by = join_by(Handle)) |>
  View()






