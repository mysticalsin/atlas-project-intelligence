'use strict';
// Node 22 skips a nested `node --test` and exits 0 while NODE_TEST_CONTEXT is set.
// The workerd tail check spawns that nested run. `--test` is already in execArgv
// and the context is set. A normal test worker has an empty execArgv. Drop the
// marker only for that nested file so it actually runs.
const nestedTail = process.execArgv.includes('--test')
  && process.env.NODE_TEST_CONTEXT
  && process.argv.some(arg => arg.endsWith('write-sql-tail.test.js'));
if (nestedTail) delete process.env.NODE_TEST_CONTEXT;
