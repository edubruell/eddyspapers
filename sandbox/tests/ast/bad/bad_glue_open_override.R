# Custom delimiters would move interpolation outside the { } the checker inspects.
emit_note(glue("[system('id')]", .open = "[", .close = "]"))
