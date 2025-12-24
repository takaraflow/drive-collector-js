import { jest, describe, test, expect, beforeAll, afterAll } from "@jest/globals";

// Mock the config module to provide dummy credentials
jest.unstable_mockModule("../../src/config/index.js", () => ({
  config: {
    apiId: 12345,
    apiHash: "mock_hash",
  },
}));

// Mock SettingsRepository to prevent DB calls
jest.unstable_mockModule("../../src/repositories/SettingsRepository.js", () => ({
  SettingsRepository: {
    get: jest.fn().mockResolvedValue(""),
    set: jest.fn().mockResolvedValue(true),
  },
}));

// Mock the Telegram library itself to prevent network calls
jest.unstable_mockModule("telegram", () => ({
  TelegramClient: jest.fn().mockImplementation(() => ({
    // Mock any methods that might be called
    constructor: { name: "TelegramClient" },
  })),
  sessions: {
    StringSession: jest.fn(),
  },
}));

describe("Telegram Service", () => {
  let client;

  beforeAll(async () => {
    // Dynamically import the module AFTER mocks are set up
    const telegramService = await import("../../src/services/telegram.js");
    client = telegramService.client;
  });

  afterAll(() => {
    jest.resetModules();
  });

  test("should initialize the Telegram client", () => {
    expect(client).toBeDefined();
  });

  test("should have the correct client type", () => {
    expect(client.constructor.name).toBe("TelegramClient");
  });
});