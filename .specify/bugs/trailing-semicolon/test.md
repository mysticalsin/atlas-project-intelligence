# Test: trailing-semicolon

On 22990053 native is ALLOW and fallback is SQL_MULTI. After the fix both allow SELECT 1; and both refuse SELECT 1;;. Treating every semicolon as a second statement makes the fallback SQL_MULTI again.
