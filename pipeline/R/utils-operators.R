#' Null-coalescing operator
#'
#' Returns `x` unless it is `NULL`, in which case it returns `y`. Defined
#' package-internally so the package does not depend on base R >= 4.4, where
#' `%||%` was added to base.
#'
#' @param x,y Values; `y` is returned when `x` is `NULL`.
#' @return `x` if not `NULL`, otherwise `y`.
#' @keywords internal
`%||%` <- function(x, y) if (is.null(x)) y else x
