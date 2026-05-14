import { describe, it, expect } from 'vitest';
import { TaskManager } from '../../../../src/processor/TaskManager.js';
import { TaskManagerCore } from '../../../../src/processor/TaskManager/TaskManager.core.js';

describe('TaskManager SSOT', () => {
    it('should expose TaskManagerCore as the production TaskManager implementation', () => {
        expect(TaskManagerCore).toBe(TaskManager);
    });
});
