import fs from 'fs';
let testCode = fs.readFileSync('__tests__/ui/templates.test.js', 'utf8');

// The tests for renderBatchMonitor expect the output from our new string template formatting
testCode = testCode.replace(
    /expect\(result\.text\)\.toContain\("<code>\[██████████░░░░░░░░░░\]<\/code> 50%"\);/g,
    'expect(result.text).toContain("<code>[██████████░░░░░░░░░░] 50%</code>");'
);
testCode = testCode.replace(
    /expect\(result25\.text\)\.toContain\("<code>\[█████░░░░░░░░░░░░░░░\]<\/code> 25% \(25 MB\/100 MB\)"\);/g,
    'expect(result25.text).toContain("<code>[█████░░░░░░░░░░░░░░░] 25%</code> (25 MB/100 MB)");'
);
testCode = testCode.replace(
    /expect\(result75\.text\)\.toContain\("<code>\[███████████████░░░░░\]<\/code> 75% \(75 MB\/100 MB\)"\);/g,
    'expect(result75.text).toContain("<code>[███████████████░░░░░] 75%</code> (75 MB/100 MB)");'
);
testCode = testCode.replace(
    /expect\(result100\.text\)\.toContain\("<code>\[████████████████████\]<\/code> 100% \(100 MB\/100 MB\)"\);/g,
    'expect(result100.text).toContain("<code>[████████████████████] 100%</code> (100 MB/100 MB)");'
);


fs.writeFileSync('__tests__/ui/templates.test.js', testCode);
