# Fix: attach-detach

attach and detach are mutating verbs, and alwaysBlocked refuses them even when a door is open and even under EXPLAIN QUERY PLAN.
