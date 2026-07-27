# Any computed callee is rejected, regardless of what it indexes.
fns <- list(nchar)
fns[[1]]("x")
