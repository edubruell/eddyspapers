# Common, safe base + dplyr helpers that were previously (wrongly) rejected.
vals <- c(1, NA, 3)
clean <- ifelse(is.na(vals), 0, vals)
flat <- unlist(list(a = 1, b = 2))
named <- setNames(1:3, c("x", "y", "z"))
tab <- tibble(g = c("a", "a", "b"), v = 1:3)
rolled <- tab |>
  group_by(g) |>
  summarise(total = sum(v), .groups = "drop") |>
  mutate(kind = if_else(total > 2, "big", "small"))
emit_section("Rolled", rolled)
