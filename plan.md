1. **Fix Insecure Math.random() Usage in StreamTransferService (StreamTransferService.js)**
   - The application relies on `Math.random()` to generate the `finalizeToken` for completing a resumable stream upload. Because `Math.random()` is not cryptographically secure, an attacker could potentially guess the `finalizeToken`, allowing them to bypass the finalization verification step or finalize streams maliciously.
   - We will replace `Math.random().toString(36).slice(2)` with the standard, cryptographically secure `crypto.randomUUID()` in the `_startResumableFinalization` function. We need to make sure we import `crypto` at the top of the file since it is not currently imported in this file.
   - We will use the `replace_with_git_merge_diff` tool to apply this code edit.

2. **Add a Journal Entry**
   - The usage of `Math.random()` for critical, security-sensitive tokens is a vulnerability in distributed and secure systems.
   - We will append a new entry in `.jules/sentinel.md` documenting this finding and the mitigation using `run_in_bash_session` with `echo -e >>`.

3. **Run tests**
   - We will execute the CI suite (`pnpm run ci:full`) using `run_in_bash_session` to ensure no tests or functionalities are broken by the change.

4. **Complete pre-commit steps to ensure proper testing, verification, review, and reflection are done.**
   - We will run the `pre_commit_instructions` tool and adhere to its instructions before making any git commit.

5. **Submit the PR**
   - After verification and test completion, we will submit the changes by providing an appropriate descriptive message emphasizing the security impact and using the `submit` tool.
