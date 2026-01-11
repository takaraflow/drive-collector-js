import { BaseQueue } from "../../../src/services/queue/BaseQueue.js";

describe("BaseQueue - Abstract Class Behavior", () => {
    test("should throw when trying to instantiate directly", () => {
        expect(() => new BaseQueue()).toThrow("BaseQueue is an abstract class and cannot be instantiated directly");
    });

    test("should allow subclass instantiation", () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        expect(queue).toBeInstanceOf(BaseQueue);
        expect(queue.providerName).toBe('MockQueue');
    });

    test("should track initialization state", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        expect(queue.isInitialized).toBe(false);

        await queue.initialize();
        expect(queue.isInitialized).toBe(true);
    });

    test("should track connection state", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {
                this.connected = true;
            }
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        expect(queue.connected).toBe(false);

        await queue.connect();
        expect(queue.connected).toBe(true);

        await queue.disconnect();
        expect(queue.connected).toBe(false);
    });

    test("should allow connect without _connect implementation", async () => {
        class MockQueue extends BaseQueue {
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();
        expect(queue.connected).toBe(true);
    });

    test("should throw when publishing without connection", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();

        await expect(queue.publish("test", { data: "test" })).rejects.toThrow("Not connected");
    });

    test("should throw when batch publishing without connection", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();

        await expect(queue.batchPublish([])).rejects.toThrow("Not connected");
    });

    test("should call _publish when connected", async () => {
        const mockPublish = vi.fn().mockResolvedValue({ messageId: "test-id" });

        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish(topic, message, options) {
                return mockPublish(topic, message, options);
            }
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();

        const result = await queue.publish("test-topic", { data: "test" });
        expect(mockPublish).toHaveBeenCalledWith("test-topic", { data: "test" }, {});
        expect(result).toEqual({ messageId: "test-id" });
    });

    test("should throw when _publish not implemented", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();

        await expect(queue.publish("test", {})).rejects.toThrow("Not implemented");
    });

    test("should call _batchPublish when connected", async () => {
        const mockBatchPublish = vi.fn().mockResolvedValue([{ messageId: "test-id" }]);

        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish(messages) {
                return mockBatchPublish(messages);
            }
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();

        const messages = [{ topic: "test", message: { data: "test" } }];
        const result = await queue.batchPublish(messages);
        expect(mockBatchPublish).toHaveBeenCalledWith(messages);
        expect(result).toEqual([{ messageId: "test-id" }]);
    });

    test("should throw when _batchPublish not implemented", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();

        await expect(queue.batchPublish([])).rejects.toThrow("Not implemented");
    });

    test("should call _verifyWebhook when implemented", async () => {
        const mockVerify = vi.fn().mockResolvedValue(true);

        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook(signature, body) {
                return mockVerify(signature, body);
            }
        }

        const queue = new MockQueue();

        const result = await queue.verifyWebhook("sig123", "body123");
        expect(mockVerify).toHaveBeenCalledWith("sig123", "body123");
        expect(result).toBe(true);
    });

    test("should throw when _verifyWebhook not implemented", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
        }

        const queue = new MockQueue();

        await expect(queue.verifyWebhook("sig", "body")).rejects.toThrow("Not implemented");
    });

    test("should get provider name", () => {
        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        expect(queue.getProviderName()).toBe('MockQueue');
    });

    test("should get connection info", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {
                this.connected = true;
            }
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();

        expect(queue.getConnectionInfo()).toEqual({
            provider: 'MockQueue',
            connected: false
        });

        await queue.connect();
        expect(queue.getConnectionInfo()).toEqual({
            provider: 'MockQueue',
            connected: true
        });
    });

    test("should destroy properly", async () => {
        class MockQueue extends BaseQueue {
            async _connect() {
                this.connected = true;
            }
            async _disconnect() {
                this.connected = false;
            }
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();
        expect(queue.connected).toBe(true);

        await queue.destroy();
        expect(queue.connected).toBe(false);
    });

    test("should skip connect if already connected", async () => {
        const mockConnect = vi.fn();

        class MockQueue extends BaseQueue {
            async _connect() {
                mockConnect();
                this.connected = true;
            }
            async _disconnect() {}
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.connect();
        expect(mockConnect).toHaveBeenCalledTimes(1);

        await queue.connect();
        expect(mockConnect).toHaveBeenCalledTimes(1);
    });

    test("should skip disconnect if not connected", async () => {
        const mockDisconnect = vi.fn();

        class MockQueue extends BaseQueue {
            async _connect() {}
            async _disconnect() {
                mockDisconnect();
                this.connected = false;
            }
            async _publish() {}
            async _batchPublish() {}
            async _verifyWebhook() {}
        }

        const queue = new MockQueue();
        await queue.disconnect();
        expect(mockDisconnect).not.toHaveBeenCalled();
    });
});
