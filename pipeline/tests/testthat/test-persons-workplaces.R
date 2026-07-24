# Regression tests for the M8 multi-workplace extraction in
# post_process_person_entry: a person entry with NO workplace element crashed
# on real data before the typed prototype (purrr::list_rbind over an empty
# list yields a column-less tibble; dplyr::filter on it then errors).
# Entry lists are built by hand mirroring the ReDIF parser output shape:
#   entry$workplace = list(list(name = list("X"),
#                               institution = list("RePEc:edi:x"),
#                               share = list("97")))

if (!exists("post_process_person_entry", mode = "function")) {
  r_dir <- normalizePath(file.path(testthat::test_path(), "..", "..", "R"),
                         mustWork = FALSE)
  if (!dir.exists(r_dir)) {
    r_dir <- normalizePath(file.path("pipeline", "R"), mustWork = FALSE)
  }
  assign("log_file", tempfile(fileext = ".log"), envir = .GlobalEnv)
  source(file.path(r_dir, "utils-operators.R"))
  source(file.path(r_dir, "update_logs.R"))
  source(file.path(r_dir, "persons.R"))
}

person_entry <- function(workplace = NULL) {
  entry <- list(
    TYPE = "ReDIF-Person 1.0",
    ID = "RePEc:per:1965-11-25:test_person",
    `short-id` = list("pte1"),
    `name-full` = list("Test Person"),
    `author-article` = list("RePEc:aea:aecrev:v:1:y:2020:p:1")
  )
  if (!is.null(workplace)) entry$workplace <- workplace
  entry
}

wp_proto_names <- c("edi_handle", "name", "share", "rank")

test_that("zero workplaces yields an empty typed workplaces tibble (regression)", {
  res <- post_process_person_entry(person_entry())

  expect_type(res, "list")
  wp <- res$workplaces[[1]]
  expect_s3_class(wp, "tbl_df")
  expect_equal(nrow(wp), 0)
  expect_named(wp, wp_proto_names)
  expect_type(wp$edi_handle, "character")
  expect_type(wp$name, "character")
  expect_type(wp$share, "double")
  expect_type(wp$rank, "integer")
  expect_equal(res$workplace_name, "")
  expect_equal(res$workplace_institution, "")
})

test_that("an empty workplace sub-entry is filtered, still yielding typed empty", {
  # Parser can emit a workplace element with neither name nor institution.
  res <- post_process_person_entry(person_entry(workplace = list(list())))

  wp <- res$workplaces[[1]]
  expect_equal(nrow(wp), 0)
  expect_named(wp, wp_proto_names)
  expect_equal(res$workplace_name, "")
  expect_equal(res$workplace_institution, "")
})

test_that("one workplace without share gets NA share and rank 1", {
  res <- post_process_person_entry(person_entry(workplace = list(
    list(name = list("ZEW Mannheim"), institution = list("RePEc:edi:zemande"))
  )))

  wp <- res$workplaces[[1]]
  expect_equal(nrow(wp), 1)
  expect_equal(wp$edi_handle, "RePEc:edi:zemande")
  expect_equal(wp$name, "ZEW Mannheim")
  expect_true(is.na(wp$share))
  expect_equal(wp$rank, 1L)
  expect_equal(res$workplace_name, "ZEW Mannheim")
  expect_equal(res$workplace_institution, "RePEc:edi:zemande")
})

test_that("multiple workplaces keep shares, document order, and first-wins scalars", {
  res <- post_process_person_entry(person_entry(workplace = list(
    list(name = list("University A"), institution = list("RePEc:edi:aaa"),
         share = list("97")),
    list(name = list("Institute B"), institution = list("RePEc:edi:bbb"),
         share = list("3"))
  )))

  wp <- res$workplaces[[1]]
  expect_equal(nrow(wp), 2)
  expect_equal(wp$rank, c(1L, 2L))
  expect_equal(wp$edi_handle, c("RePEc:edi:aaa", "RePEc:edi:bbb"))
  expect_equal(wp$share, c(97, 3))
  # persons table keeps the FIRST workplace, unchanged from pre-M8 behaviour.
  expect_equal(res$workplace_name, "University A")
  expect_equal(res$workplace_institution, "RePEc:edi:aaa")
})

test_that("a non-numeric share becomes NA without a warning", {
  expect_no_warning(
    res <- post_process_person_entry(person_entry(workplace = list(
      list(name = list("Somewhere"), institution = list("RePEc:edi:sw"),
           share = list("n/a"))
    )))
  )
  expect_true(is.na(res$workplaces[[1]]$share))
})

test_that("a workplace with only an institution handle survives the filter", {
  res <- post_process_person_entry(person_entry(workplace = list(
    list(institution = list("RePEc:edi:only"))
  )))

  wp <- res$workplaces[[1]]
  expect_equal(nrow(wp), 1)
  expect_equal(wp$edi_handle, "RePEc:edi:only")
  expect_equal(wp$name, "")
})
