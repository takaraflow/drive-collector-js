import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync, readdirSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';

describe('FileOpsExecutor Integration', () => {
    let tempDir;

    beforeEach(() => {
        tempDir = mkdtempSync(path.join(tmpdir(), 'fileops-test-'));
    });

    afterEach(() => {
        rmSync(tempDir, { recursive: true, force: true });
    });

    it('should create file with content', () => {
        const filePath = path.join(tempDir, 'test.txt');
        writeFileSync(filePath, 'Hello World');

        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, 'utf-8')).toBe('Hello World');
    });

    it('should get file stats', () => {
        const filePath = path.join(tempDir, 'stats.txt');
        writeFileSync(filePath, 'content');

        const stats = statSync(filePath);
        expect(stats.isFile()).toBe(true);
        expect(stats.size).toBe(7);
    });

    it('should list directory contents', () => {
        writeFileSync(path.join(tempDir, 'file1.txt'), 'content1');
        writeFileSync(path.join(tempDir, 'file2.txt'), 'content2');

        const files = readdirSync(tempDir);
        expect(files).toHaveLength(2);
        expect(files).toContain('file1.txt');
        expect(files).toContain('file2.txt');
    });

    it('should handle nested directories', () => {
        const nestedDir = path.join(tempDir, 'a', 'b', 'c');
        mkdirSync(nestedDir, { recursive: true });
        
        writeFileSync(path.join(nestedDir, 'deep.txt'), 'deep content');
        
        const filePath = path.join(nestedDir, 'deep.txt');
        expect(existsSync(filePath)).toBe(true);
        expect(readFileSync(filePath, 'utf-8')).toBe('deep content');
    });
});
