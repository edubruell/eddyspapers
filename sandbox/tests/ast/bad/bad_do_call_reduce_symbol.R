# S1: blocked symbol smuggled past do.call's first-arg check via a later argument.
do.call("Reduce", list(system, list("id")))
