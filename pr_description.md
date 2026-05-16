🔒 Fix regex injection vulnerability in PathResolver and CacheService

🎯 **What:**
A Regular Expression Denial of Service (ReDoS) and regex injection vulnerability existed in `src/domain/PathResolver.js` (in `shouldIgnore` and `matchPattern`) and in `src/services/CacheService.js` (in `_matchPattern`). User-provided patterns with wildcard rules were directly injected into a `RegExp` object constructor without proper escaping. Only `*` and `?` were being properly translated, leaving other regex characters (like `.`, `+`, `[`, `]`, `(`, `)`) active.

⚠️ **Risk:**
Attackers or malicious inputs could craft specific file paths or rules exploiting these unescaped characters. This allows arbitrary pattern matching bypassing intended filters or rules (Regex Injection). Furthermore, certain complex unescaped patterns might evaluate with extreme backtracking times resulting in a ReDoS vector, potentially leading to significant performance degradation or service crashes.

🛡️ **Solution:**
The fix escapes all special regex characters (such as `+`, `[`, `]`, `(`, `)`, `$`, `^`, etc.) using a standard string replacement method before wildcard translations apply. In `PathResolver.js`, it properly escapes characters leaving `*` safe to map to `.*`. In `CacheService.js`, the escape logic correctly accommodates both `*` and `?` wildcards. Robust unit tests (`PathResolver.test.js`) have been added to verify regex injections are thwarted and standard glob matching continues to work reliably.
