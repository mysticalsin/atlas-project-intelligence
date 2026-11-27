# Test: insights-body

On b9d1ac13 an owner with no body gets 400 and an owner with {} gets 403. After the fix both are 403, and a reviewer with no body matches {}.
