# Network exfil: make.socket passed as a value to Reduce. Now on the denylist (and
# masked at runtime as defense-in-depth).
s <- Reduce(make.socket, list(9098), "127.0.0.1")
Reduce(write.socket, list("stolen"), s)
