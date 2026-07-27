# Locally-bound names that collide with blocked base functions are the user's own
# variables (they shadow base), so they must be accepted: `file` as a for-loop var,
# `url` as a lambda formal.
totals <- 0
for (file in c("a", "bb", "ccc")) {
  totals <- totals + str_length(file)
}

adder <- function(url) paste0("https://ideas.repec.org/", url)
links <- map_chr(c("p/x", "p/y"), adder)

emit_note(paste("total", totals, "links", length(links)))
