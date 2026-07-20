capture_events <- function(expr) {
  tmp <- tempfile()
  con <- file(tmp, "w")
  old <- .sandbox_state$fd3
  .sandbox_state$fd3 <- con
  on.exit({
    try(close(con), silent = TRUE)
    .sandbox_state$fd3 <- old
    unlink(tmp)
  })
  force(expr)
  flush(con)
  close(con)
  .sandbox_state$fd3 <- old
  lines <- readLines(tmp)
  lapply(lines[nchar(lines) > 0], jsonlite::fromJSON)
}

test_that("emit_progress produces event with type=progress and correct label", {
  events <- capture_events(emit_progress("hello"))
  expect_length(events, 1)
  expect_equal(events[[1]]$type, "progress")
  expect_equal(events[[1]]$label, "hello")
})

test_that("emit_note produces event with type=note", {
  events <- capture_events(emit_note("some markdown"))
  expect_length(events, 1)
  expect_equal(events[[1]]$type, "note")
  expect_equal(events[[1]]$markdown, "some markdown")
})

test_that("emit_bibtex produces event with type=bibtex and both handles", {
  .sandbox_state$bibtex_handles <- character(0)
  events <- capture_events(emit_bibtex(c("h1", "h2")))
  expect_length(events, 1)
  expect_equal(events[[1]]$type, "bibtex")
  expect_true("h1" %in% events[[1]]$handles)
  expect_true("h2" %in% events[[1]]$handles)
})

test_that("calling emit_bibtex twice deduplicates handles", {
  .sandbox_state$bibtex_handles <- character(0)
  events <- capture_events({
    emit_bibtex(c("h1", "h2"))
    emit_bibtex(c("h2", "h3"))
  })
  expect_length(events, 2)
  last_event <- events[[2]]
  expect_equal(last_event$type, "bibtex")
  expect_equal(sort(last_event$handles), sort(c("h1", "h2", "h3")))
  expect_equal(length(last_event$handles), 3)
})

test_that("emit_bibtex accumulates handles across calls and deduplicates in state", {
  .sandbox_state$bibtex_handles <- character(0)
  capture_events({
    emit_bibtex(c("h1", "h2"))
    emit_bibtex(c("h2", "h3"))
    emit_bibtex(c("h1", "h3"))
  })
  expect_equal(sort(.sandbox_state$bibtex_handles), c("h1", "h2", "h3"))
})

make_section_df <- function(n = 3) {
  data.frame(
    Handle   = paste0("repec:test:paper:", seq_len(n)),
    title    = paste0("Title ", seq_len(n)),
    year     = 2020L,
    authors  = "Smith, J",
    journal  = "Test Journal",
    category = "econ",
    url      = "",
    stringsAsFactors = FALSE
  )
}

test_that("emit_section on empty data frame emits only a section event with 0 handles", {
  .sandbox_state$seen_handles <- character(0)
  df_empty <- data.frame(
    Handle = character(0), title = character(0), year = integer(0),
    authors = character(0), journal = character(0), category = character(0),
    url = character(0), stringsAsFactors = FALSE
  )
  events      <- capture_events(emit_section("Empty", df_empty))
  sec_events  <- Filter(function(e) e$type == "section", events)
  paper_events <- Filter(function(e) e$type == "paper", events)
  expect_length(sec_events, 1)
  expect_length(paper_events, 0)
  expect_equal(sec_events[[1]]$title, "Empty")
  expect_length(sec_events[[1]]$handles, 0)
})

test_that("emit_section where df has more rows than n only includes top n in section", {
  .sandbox_state$seen_handles <- character(0)
  df     <- make_section_df(5)
  events <- capture_events(emit_section("Top2", df, n = 2))
  paper_events  <- Filter(function(e) e$type == "paper", events)
  sec_events    <- Filter(function(e) e$type == "section", events)
  expect_length(paper_events, 2)
  expect_length(sec_events[[1]]$handles, 2)
  expect_equal(sec_events[[1]]$handles, df$Handle[1:2])
})

test_that("emit_section deduplicates paper events across two calls with overlapping handles", {
  .sandbox_state$seen_handles <- character(0)
  df     <- make_section_df(3)
  events <- capture_events({
    emit_section("First", df)
    emit_section("Second", df)
  })
  paper_events  <- Filter(function(e) e$type == "paper", events)
  sec_events    <- Filter(function(e) e$type == "section", events)
  expect_length(paper_events, 3)
  expect_length(sec_events, 2)
  expect_equal(sec_events[[1]]$title, "First")
  expect_equal(sec_events[[2]]$title, "Second")
})

test_that("emit_section emits paper events for new handles and section event with all handles", {
  .sandbox_state$seen_handles <- character(0)
  df     <- make_section_df(3)
  events <- capture_events(emit_section("Papers", df))
  paper_events <- Filter(function(e) e$type == "paper", events)
  sec_events   <- Filter(function(e) e$type == "section", events)
  expect_length(paper_events, 3)
  expect_length(sec_events, 1)
  expect_equal(sec_events[[1]]$title, "Papers")
  expect_equal(sort(sec_events[[1]]$handles), sort(df$Handle))
})

test_that("emit_section n > nrow(df) emits all rows without error", {
  .sandbox_state$seen_handles <- character(0)
  df     <- make_section_df(2)
  events <- capture_events(emit_section("Small", df, n = 10))
  paper_events <- Filter(function(e) e$type == "paper", events)
  expect_length(paper_events, 2)
})
