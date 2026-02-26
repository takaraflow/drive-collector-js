import { execSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('GitExecutor Integration', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = mkdtempSync(path.join(tmpdir(), 'git-test-'));
        execSync('git init', { cwd: tempDir, stdio: 'pipe' });
        execSync('git config user.email "test@test.com"', { cwd: tempDir, stdio: 'pipe' });
        execSync('git config user.name "Test"', { cwd: tempDir, stdio: 'pipe' });
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('should create initial commit', () => {
        writeFileSync(path.join(tempDir, 'README.md'), '# Test');
        execSync('git add README.md', { cwd: tempDir, stdio: 'pipe' });
        execSync('git commit -m "initial"', { cwd: tempDir, stdio: 'pipe' });

        const result = execSync('git rev-parse HEAD', { cwd: tempDir, encoding: 'utf-8' });
        expect(result.trim()).toHaveLength(40);
    });

    it('should detect staged changes', () => {
        writeFileSync(path.join(tempDir, 'new.txt'), 'content');
        execSync('git add new.txt', { cwd: tempDir, stdio: 'pipe' });

        const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf-8' });
        expect(status).toContain('A  new.txt');
    });

    it('should detect unstaged changes', () => {
        writeFileSync(path.join(tempDir, 'modified.txt'), 'modified');
        
        const status = execSync('git status --porcelain', { cwd: tempDir, encoding: 'utf-8' });
        expect(status).toMatch(/\?\? modified\.txt/);
    });
});
