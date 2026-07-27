# An assignment target is NOT treated as bound, so the RHS reference to base `system`
# is still checked and rejected — closing the `system <- system` self-launder.
system <- system
lapply(list("id"), system)
