// Import the client from the telegram service
import { client } from "../../src/services/telegram.js";

describe("Telegram Service", () => {
  test("should initialize the Telegram client", () => {
    // Check if the client is defined
    expect(client).toBeDefined();
  });

  test("should have the correct client type", () => {
    // Check if the client is an instance of TelegramClient
    expect(client.constructor.name).toBe("TelegramClient");
  });
});