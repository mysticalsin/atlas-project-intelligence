# Fix: qualified-audit

Names are read as the qualifier and the object, quotes included. OR conflict clauses are skipped. INSERT and REPLACE of the four protected tables are refused, except a plain insert into consent_receipts. After a non-receipt mutation the chain is verified again and a mismatch rolls back.
