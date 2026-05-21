test_that("paper_url builds IDEAS URL from repec handle", {
  result <- paper_url("repec:nbr:nberwo:1234")
  expect_equal(result, "https://ideas.repec.org/nbr/nberwo/1234")
})

test_that("paper_url with NULL url falls back to IDEAS URL", {
  result <- paper_url("repec:nbr:nberwo:1234", NULL)
  expect_equal(result, "https://ideas.repec.org/nbr/nberwo/1234")
})

test_that("paper_url with empty string url falls back to IDEAS URL", {
  result <- paper_url("repec:nbr:nberwo:1234", "")
  expect_equal(result, "https://ideas.repec.org/nbr/nberwo/1234")
})

test_that("paper_url with non-empty url returns that url as-is", {
  result <- paper_url("repec:nbr:nberwo:1234", "https://example.com/paper")
  expect_equal(result, "https://example.com/paper")
})

test_that("paper_url replaces colons after repec: prefix with slashes", {
  result <- paper_url("repec:aea:aecrev:v:10:y:2020:p:1-30")
  expect_equal(result, "https://ideas.repec.org/aea/aecrev/v/10/y/2020/p/1-30")
})
