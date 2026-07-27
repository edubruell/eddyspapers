handles <- c("RePEc:a:b:1", "RePEc:a:b:2")

upper   <- lapply(handles, toupper)
lengths <- map_int(handles, str_length)

double  <- function(x) x * 2
scaled  <- lapply(c(1, 2, 3), double)

combos  <- Map(function(a, b) paste(a, b), handles, upper)

emit_note(paste("checked", length(upper), "handles"))
