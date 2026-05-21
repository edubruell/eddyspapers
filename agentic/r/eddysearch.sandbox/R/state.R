.sandbox_state <- new.env(parent = emptyenv())
.sandbox_state$con <- NULL
.sandbox_state$fd3 <- NULL
.sandbox_state$seen_handles <- character(0)
.sandbox_state$bibtex_handles <- character(0)
