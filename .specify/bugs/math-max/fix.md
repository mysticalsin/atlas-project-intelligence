# Fix: math-max

primordials.js captures Math.max the same way as Math.min. mustMost checks the result. The three sites call mustMost.
