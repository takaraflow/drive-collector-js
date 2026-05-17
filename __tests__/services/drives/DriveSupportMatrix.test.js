import { describe, expect, test } from 'vitest';
import { DriveProviderFactory } from '../../../src/services/drives/index.js';

describe('Drive support matrix', () => {
  test('should expose only audited default drives as stable', () => {
    const drives = DriveProviderFactory.getSupportedDrives();
    const byType = new Map(drives.map(drive => [drive.type, drive]));

    expect([...byType.keys()].sort()).toEqual([
      'box',
      'dropbox',
      'google_drive',
      'mega',
      'onedrive',
      'oss',
      'pcloud',
      'pikpak',
      'webdav'
    ]);

    expect(byType.get('mega')).toMatchObject({ supportLevel: 'stable' });
    expect(byType.get('webdav')).toMatchObject({ supportLevel: 'stable' });

    for (const type of ['box', 'dropbox', 'google_drive', 'onedrive', 'oss', 'pcloud', 'pikpak']) {
      expect(byType.get(type)).toMatchObject({ supportLevel: 'advanced' });
      expect(byType.get(type).supportNote).toEqual(expect.any(String));
      expect(byType.get(type).supportNote.length).toBeGreaterThan(0);
    }
  });

  test('advanced providers should still have complete binding steps and rclone connection strings', () => {
    for (const type of ['box', 'dropbox', 'google_drive', 'onedrive', 'oss', 'pcloud', 'pikpak']) {
      const provider = DriveProviderFactory.getProvider(type);
      expect(provider.getBindingSteps().length).toBeGreaterThan(0);
      expect(provider.getConnectionString(sampleConfigFor(type))).toMatch(/^:.+:/);
    }
  });
});

function sampleConfigFor(type) {
  const token = JSON.stringify({ access_token: 'access', refresh_token: 'refresh' });
  switch (type) {
    case 'box':
    case 'dropbox':
    case 'google_drive':
      return { token };
    case 'pcloud':
      return { token: JSON.stringify({ access_token: 'access' }), hostname: 'api.pcloud.com' };
    case 'onedrive':
      return { token, drive_id: 'drive-id', drive_type: 'personal' };
    case 'oss':
      return { endpoint: 's3.example.com', bucket: 'bucket-name', ak: 'access-key', sk: 'secret-key' };
    case 'pikpak':
      return { user: 'user@example.com', pass: 'password' };
    default:
      return {};
  }
}
