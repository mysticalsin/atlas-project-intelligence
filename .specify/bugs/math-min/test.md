# Test: math-min

On 22990053 the ref count is 0. After the fix the count is 1. The word scan calling live Math.min deletes the row again (expected 1 actual 0).
