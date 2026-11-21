# Fix: eval-alias

parameterTaint records a declarator or assignment whose value is eval or a member named eval. isEvalCall treats that name as eval. The set is reset on each lint.
