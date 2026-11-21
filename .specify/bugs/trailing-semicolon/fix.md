# Fix: trailing-semicolon

scanSemi allows one semicolon whose tail is only whitespace or comments. The native path applies that rule when the prepared tail still contains a semicolon.
