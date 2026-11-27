# Test: consent delete on a damaged chain

## Reproduction
The corrected test, with the guard absent: 1 test, 0 pass, 1 fail, `AssertionError` expected 1 actual 0. Log `/tmp/v6-red-chain2.txt`.

## Result
verified

After `08ac4bcb95511973738696ee9d3477f3569d246f` the chain test and the checkpoint file are 9 pass, 0 fail. Teams-seen on a damaged chain still passes.
