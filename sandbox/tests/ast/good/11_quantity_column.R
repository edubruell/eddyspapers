# `q` (quantity) is a normal economics column name; it must be accepted as data even
# though `q()` (quit) is blocked as a call.
demand <- tibble(p = 1:3, q = 4:6)
priced <- mutate(demand, revenue = p * q)
emit_section("Demand", priced)
