import { describe, expect, test, vi } from 'vitest';

const mockCache = {
    delete: vi.fn(),
    get: vi.fn()
};

const mockDriveRepository = {
    create: vi.fn(),
    deleteByUserId: vi.fn(),
    findAll: vi.fn(),
    findByUserId: vi.fn(),
    getDriveIdKey: vi.fn(driveId => `drive_id:${driveId}`),
    getDriveKey: vi.fn(userId => `drive:${userId}`)
};

vi.mock('../../src/services/CacheService.js', () => ({
    cache: mockCache
}));

vi.mock('../../src/repositories/DriveRepository.js', () => ({
    DriveRepository: mockDriveRepository
}));

vi.mock('../../src/services/logger/index.js', () => ({
    logger: {
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn()
    }
}));

const { verifyDrivePersistence } = await import('../../scripts/verify-drive-persistence.js');

describe('verify-drive-persistence script', () => {
    test('should handle repository drive lists and canonical test config', async () => {
        const createdDrive = {
            id: 'drive-test',
            name: 'Test-Mega-Persistence',
            type: 'mega',
            config_data: JSON.stringify({
                user: 'test@example.com',
                pass: 'test_obscured_password_123',
                pass_format: 'rclone_obscured',
                config_schema_version: 1
            })
        };

        mockDriveRepository.findAll.mockResolvedValue([]);
        mockDriveRepository.create.mockResolvedValue(true);
        mockDriveRepository.findByUserId
            .mockResolvedValueOnce([createdDrive])
            .mockResolvedValueOnce([createdDrive])
            .mockResolvedValueOnce([]);
        mockDriveRepository.deleteByUserId.mockResolvedValue(undefined);
        mockCache.delete.mockResolvedValue(true);
        mockCache.get.mockResolvedValueOnce([{ id: 'drive-test' }]);

        await expect(verifyDrivePersistence()).resolves.toBeUndefined();

        expect(mockDriveRepository.create).toHaveBeenCalledWith(
            'test_persistence_user',
            'Test-Mega-Persistence',
            'mega',
            {
                user: 'test@example.com',
                pass: 'test_obscured_password_123',
                pass_format: 'rclone_obscured',
                config_schema_version: 1
            }
        );
        expect(mockDriveRepository.findByUserId).toHaveBeenCalledTimes(3);
        expect(mockDriveRepository.deleteByUserId).toHaveBeenCalledWith('test_persistence_user');
    });
});
