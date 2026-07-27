# glue() evaluates R inside { } — embedded blocked calls must be caught.
x <- glue("result: {system('id')}")
emit_note(x)
