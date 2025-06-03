import { describe, it, expect, mock, spyOn } from "bun:test";

// Mock child_process.exec
mock.module("child_process", () => ({
  exec: mock(() => {})
}));

// Mock run-applescript to always resolve with text
mock.module("run-applescript", () => ({ runAppleScript: mock(() => Promise.resolve("Hello world")) }));

import * as index from "../index";

// Stub checkChatGPTAccess to avoid real AppleScript
spyOn(index, "checkChatGPTAccess").mockResolvedValue(true);

describe("isChatGPTArgs", () => {
  it("accepts speak boolean", () => {
    const args = { operation: "ask", prompt: "hi", speak: true };
    expect(index.isChatGPTArgs(args)).toBe(true);
  });

  it("rejects invalid speak type", () => {
    const args = { operation: "ask", prompt: "hi", speak: "yes" } as any;
    expect(index.isChatGPTArgs(args)).toBe(false);
  });
});

describe("askChatGPT", () => {
  it("calls say when speak is true", async () => {
    const child = await import("child_process");
    const execSpy = spyOn(child, "exec");
    const result = await index.askChatGPT("Hi", undefined, true);
    expect(result).toBe("Hello world");
    expect(execSpy).toHaveBeenCalled();
  });
});
