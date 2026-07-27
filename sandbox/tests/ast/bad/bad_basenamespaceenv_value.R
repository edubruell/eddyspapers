# base function fetched as a value via the env object, then run through a HOF.
sysfn <- .BaseNamespaceEnv[["system"]]
Map(sysfn, "echo pwned")
