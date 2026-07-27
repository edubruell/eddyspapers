# Legitimate glue: interpolating allowlisted expressions and glue-data into a literal
# template is fine and must still pass.
n <- 5L
label <- glue("Top {n} results as of {format(Sys.Date(), '%Y')}")
q <- glue("SELECT * FROM articles WHERE year >= {min_year} LIMIT 10", min_year = 2020L)
emit_note(label)
