# Fix: string-cast

String is captured at load. textOf, lower, trim, replace, slice, charCodeAt, and the sqlite remainder use it.
