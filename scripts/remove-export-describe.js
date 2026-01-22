import fs from 'fs';
import path from 'path';

// Recursively find all test files
function findTestFiles(dir, files = []) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            findTestFiles(fullPath, files);
        } else if (entry.isFile() && entry.name.endsWith('.test.js')) {
            files.push(fullPath);
        }
    }

    return files;
}

// Find all test files
const testFiles = findTestFiles('__tests__');

let modifiedCount = 0;

testFiles.forEach(filePath => {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');

    // Check if the last line is export { describe };
    const lastLineIndex = lines.length - 1;
    const lastLine = lines[lastLineIndex].trim();

    if (lastLine === 'export { describe };' || lastLine === 'export { describe }') {
        // Remove the last line and any empty lines before it
        let newLines = lines.slice(0, lastLineIndex);
        // Remove trailing empty lines
        while (newLines.length > 0 && newLines[newLines.length - 1].trim() === '') {
            newLines.pop();
        }

        const newContent = newLines.join('\n');
        fs.writeFileSync(filePath, newContent, 'utf8');
        modifiedCount++;
        console.log(`Modified: ${filePath}`);
    }
});

console.log(`\nTotal files modified: ${modifiedCount}`);
