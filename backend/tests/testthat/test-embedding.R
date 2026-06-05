# Tests for the safe embedding helpers (embed_one_safe, embed_batch_safe).
# These run WITHOUT a live Ollama server by mocking tidyllm::ollama_embedding.

# --- scaffolding -------------------------------------------------------------
# When run via test_dir() (not as an installed package), source the functions
# under test plus their logging dependencies (info/warn live in update_logs.R).
if (!exists("embed_batch_safe", mode = "function")) {
  r_dir <- normalizePath(file.path(testthat::test_path(), "..", "..", "R"),
                         mustWork = FALSE)
  if (!dir.exists(r_dir)) {
    r_dir <- normalizePath(file.path("backend", "R"), mustWork = FALSE)
  }
  # A log_file target is required by log_msg(); send it to a temp file.
  assign("log_file", tempfile(fileext = ".log"), envir = .GlobalEnv)
  source(file.path(r_dir, "update_logs.R"))
  source(file.path(r_dir, "database.R"))
}

# A fixed-length fake embedding vector, mirroring mxbai-embed-large (1024 dims).
fake_vec <- function(seed = 1) {
  set.seed(seed)
  stats::runif(1024)
}

# Build the tibble shape that tidyllm::ollama_embedding returns:
#   columns `input` (chr) and `embeddings` (list of numeric vectors).
fake_embedding_tbl <- function(inputs) {
  tibble::tibble(
    input = inputs,
    embeddings = purrr::map(seq_along(inputs), ~fake_vec(.x))
  )
}

# --- embed_batch_safe: fast path success ------------------------------------
test_that("embed_batch_safe fast path returns one embedding per input", {
  texts <- c("alpha abstract", "beta abstract", "gamma abstract")

  testthat::local_mocked_bindings(
    ollama_embedding = function(.input, ...) fake_embedding_tbl(.input),
    .package = "tidyllm"
  )

  res <- embed_batch_safe(texts, model = "mxbai-embed-large")

  expect_type(res, "list")
  expect_length(res, length(texts))
  expect_false(any(purrr::map_lgl(res, is.null)))
  expect_true(all(purrr::map_int(res, length) == 1024L))
  expect_type(res[[1]], "double")
})

# --- embed_batch_safe: error triggers per-article fallback ------------------
test_that("embed_batch_safe falls back to per-article embedding on batch error", {
  texts <- c("short one", "short two", "short three")
  call_lengths <- integer(0)

  # Batch call (length > 1) errors; single-input calls (length 1) succeed.
  testthat::local_mocked_bindings(
    ollama_embedding = function(.input, ...) {
      call_lengths[[length(call_lengths) + 1L]] <<- length(.input)
      if (length(.input) > 1L) {
        stop("simulated context-length error on whole batch")
      }
      fake_embedding_tbl(.input)
    },
    .package = "tidyllm"
  )

  res <- embed_batch_safe(texts, model = "mxbai-embed-large")

  expect_length(res, length(texts))
  expect_false(any(purrr::map_lgl(res, is.null)))
  expect_true(all(purrr::map_int(res, length) == 1024L))
  # First call was the whole batch (3), then one call per article (1 each).
  expect_equal(call_lengths[1], 3L)
  expect_true(all(call_lengths[-1] == 1L))
  expect_equal(sum(call_lengths == 1L), length(texts))
})

# --- embed_one_safe: succeeds on full text ----------------------------------
test_that("embed_one_safe returns a bare numeric vector on success", {
  testthat::local_mocked_bindings(
    ollama_embedding = function(.input, ...) fake_embedding_tbl(.input),
    .package = "tidyllm"
  )

  res <- embed_one_safe("a normal abstract", model = "mxbai-embed-large")

  expect_type(res, "double")
  expect_length(res, 1024L)
})

# --- embed_one_safe: progressive truncation rescues long input --------------
test_that("embed_one_safe retries with shorter truncation and succeeds", {
  attempted <- integer(0)

  # Error unless the truncated input is <= 800 chars.
  testthat::local_mocked_bindings(
    ollama_embedding = function(.input, ...) {
      attempted[[length(attempted) + 1L]] <<- nchar(.input)
      if (nchar(.input) > 800L) {
        stop("simulated context-length error")
      }
      fake_embedding_tbl(.input)
    },
    .package = "tidyllm"
  )

  long_text <- paste(rep("x", 5000), collapse = "")
  res <- embed_one_safe(long_text, model = "mxbai-embed-large")

  expect_type(res, "double")
  expect_length(res, 1024L)
  # It must have tried longer limits first before succeeding at <= 800.
  expect_true(any(attempted > 800L))
  expect_true(any(attempted <= 800L))
})

# --- embed_one_safe: always-erroring input yields NULL (skip) ----------------
test_that("embed_one_safe returns NULL when every truncation length errors", {
  testthat::local_mocked_bindings(
    ollama_embedding = function(.input, ...) {
      stop("simulated unrecoverable context-length error")
    },
    .package = "tidyllm"
  )

  res <- embed_one_safe("dense cyrillic abstract", model = "mxbai-embed-large")

  expect_null(res)
})

# --- embed_batch_safe: alignment with NULL holes preserved ------------------
test_that("embed_batch_safe keeps alignment with NULL holes on fallback", {
  texts <- c("good one", "POISON", "good two", "POISON", "good three")

  # Whole-batch errors; per-article: the literal "POISON" always errors.
  testthat::local_mocked_bindings(
    ollama_embedding = function(.input, ...) {
      if (length(.input) > 1L) stop("batch error")
      if (any(grepl("POISON", .input))) stop("unrecoverable for this article")
      fake_embedding_tbl(.input)
    },
    .package = "tidyllm"
  )

  res <- embed_batch_safe(texts, model = "mxbai-embed-large")

  expect_length(res, length(texts))
  null_mask <- purrr::map_lgl(res, is.null)
  # NULL holes land exactly on the POISON positions (2 and 4).
  expect_equal(which(null_mask), c(2L, 4L))
  # Non-NULL entries are full-length embeddings.
  expect_true(all(purrr::map_int(res[!null_mask], length) == 1024L))
})
