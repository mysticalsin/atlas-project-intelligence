# Fix: insights-body

The insights route returns 403 for a non-reviewer before reading the body. An empty body is {} after that check. Other POST routes still require JSON.
