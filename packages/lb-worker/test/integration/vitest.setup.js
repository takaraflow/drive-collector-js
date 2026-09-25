import { vi, beforeEach } from "vitest";

const baseEnv = { NODE_ENV: "test" };

const resetEnv = () => {
  if (typeof process !== "undefined" && process.env) {
    process.env = { ...baseEnv };
  }
};

const silenceOutput = () => {
  if (typeof console !== "undefined") {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "debug").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
  }

  if (typeof process !== "undefined") {
    if (process.stdout && typeof process.stdout.write === "function") {
      vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    }
    if (process.stderr && typeof process.stderr.write === "function") {
      vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    }
  }
};

globalThis.__TEST__ = true;

resetEnv();
silenceOutput();

beforeEach(() => {
  resetEnv();
  silenceOutput();
});
