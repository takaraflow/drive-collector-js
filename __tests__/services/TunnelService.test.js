import { describe, test, expect, vi, beforeEach } from 'vitest';
import { tunnelService } from '../../src/services/TunnelService.js';
import { getConfig } from '../../src/config/index.js';
import { CloudflareTunnel } from '../../src/services/tunnel/CloudflareTunnel.js';

vi.mock('../../src/config/index.js');
vi.mock('../../src/services/tunnel/CloudflareTunnel.js');

describe('TunnelService', () => {
    beforeEach(() => {
        vi.resetAllMocks();
    });

    test('should not initialize if disabled', async () => {
        getConfig.mockReturnValue({
            tunnel: { enabled: false }
        });

        await tunnelService.initialize();
        expect(tunnelService.provider).toBeNull();
    });

    test('should initialize CloudflareTunnel if enabled and provider is cloudflare', async () => {
        const config = {
            tunnel: {
                enabled: true,
                provider: 'cloudflare',
                metricsPort: 2000
            }
        };
        getConfig.mockReturnValue(config);

        await tunnelService.initialize();
        
        expect(CloudflareTunnel).toHaveBeenCalledWith(config.tunnel);
        expect(tunnelService.provider).toBeDefined();
    });

    test('should get public URL from provider', async () => {
        const mockUrl = 'https://test.trycloudflare.com';
        tunnelService.provider = {
            getPublicUrl: vi.fn().mockResolvedValue(mockUrl)
        };

        const url = await tunnelService.getPublicUrl();
        expect(url).toBe(mockUrl);
    });
});
