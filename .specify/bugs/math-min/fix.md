# Fix: math-min

Math.min is captured as the function, not through call, because call would consume the first number as this. A result that is not the numeric minimum fails closed.
