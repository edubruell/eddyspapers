# `base::system` in value position is rejected at the `::` node.
sys <- base::system
lapply(list("id"), sys)
