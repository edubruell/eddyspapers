# Computed callee on the base namespace env → RCE. Closed by the computed-call reject
# AND by .BaseNamespaceEnv being on the denylist.
.BaseNamespaceEnv[["system"]]("echo pwned")
