import { jest } from '@jest/globals';

describe('release-ai.js - Core Functions', () => {
  // 简化测试：只测试逻辑函数，不测试 git 命令
  describe('generateChineseChangelog', () => {
    it('should generate placeholder changelog with correct format', async () => {
      // 动态导入模块
      const { generateChineseChangelog } = await import('../../scripts/release-ai.js');
      
      const commits = 'abc123 Fix bug\nabc124 Add feature';
      const result = generateChineseChangelog(commits);

      expect(result).toContain('AI-Generated Changelog');
      expect(result).toContain('commits: 2');
      expect(result).toContain('This content should be replaced by Roo AI');
    });

    it('should handle single commit', async () => {
      const { generateChineseChangelog } = await import('../../scripts/release-ai.js');
      
      const commits = 'abc123 Fix bug';
      const result = generateChineseChangelog(commits);

      expect(result).toContain('commits: 1');
    });

    it('should handle empty commits', async () => {
      const { generateChineseChangelog } = await import('../../scripts/release-ai.js');
      
      const commits = '';
      const result = generateChineseChangelog(commits);

      expect(result).toContain('commits: 0');
    });
  });

  describe('Module Structure', () => {
    it('should export all required functions', async () => {
      const releaseAi = await import('../../scripts/release-ai.js');
      
      expect(releaseAi.getGitCommits).toBeDefined();
      expect(releaseAi.checkDirtyWorkspace).toBeDefined();
      expect(releaseAi.generateChineseChangelog).toBeDefined();
      expect(releaseAi.run).toBeDefined();
    });
  });

  describe('Integration - Script Flow', () => {
    it('should have correct script structure', async () => {
      const fs = await import('fs');
      const path = await import('path');
      
      // Check that the script file exists and has proper structure
      const scriptPath = path.join(process.cwd(), 'scripts', 'release-ai.js');
      const content = fs.readFileSync(scriptPath, 'utf8');
      
      // Verify key components exist
      expect(content).toContain('import { execSync }');
      expect(content).toContain('import fs from');
      expect(content).toContain('function getGitCommits');
      expect(content).toContain('function checkDirtyWorkspace');
      expect(content).toContain('function generateChineseChangelog');
      expect(content).toContain('async function run');
      expect(content).toContain('export {');
      // Verify new features
      expect(content).toContain('getFilesToAddFromVersionrc');
      expect(content).toContain('syncManifestVersion');
      expect(content).toContain('npm test');
    });
  });
});