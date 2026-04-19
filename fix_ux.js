import fs from 'fs';
let code = fs.readFileSync('src/ui/templates.js', 'utf8');

// Revert generateProgressBar to its original form
code = code.replace(
    'return `<code>[${bar}]</code> ${percentage}% (${formatBytes(current)}/${formatBytes(total)})`;',
    'return `[${bar}] ${percentage}%`;'
);

// Apply fix to renderBatchMonitor instead
code = code.replace(
    'const progressBar = this.generateProgressBar(downloaded, total);',
    'const progressBar = `<code>${this.generateProgressBar(downloaded, total)}</code> (${formatBytes(downloaded)}/${formatBytes(total)})`;'
);

fs.writeFileSync('src/ui/templates.js', code);
