# Fix: chain-reverify

When the audit table is ready and the transaction is not receipt-only, anchoredVerdict(verifyChain) runs after the callback. Not ok rolls back.
