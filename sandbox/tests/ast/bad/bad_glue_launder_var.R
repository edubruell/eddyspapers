# A template laundered through a variable can't be statically verified → rejected.
tmpl <- "{system('id')}"
emit_note(glue(tmpl))
