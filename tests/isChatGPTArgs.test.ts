import { describe, it, expect, mock, spyOn } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

let speechError: Error | null = null;
const execFileMock = mock(
  (
    _file: string,
    _args: string[],
    callback?: (error: Error | null) => void,
  ) => callback?.(speechError),
);

// Mock the external text-to-speech process.
mock.module("child_process", () => ({
  exec: mock(() => {}),
  execFile: execFileMock,
}));

// Mock run-applescript to always resolve with text
mock.module("run-applescript", () => ({ runAppleScript: mock(() => Promise.resolve("Hello world")) }));

import * as index from "../index";

// Stub checkChatGPTAccess to avoid real AppleScript
spyOn(index, "checkChatGPTAccess").mockResolvedValue(true);

describe("isMainModule", () => {
  it("recognizes a symlinked executable as the direct entry point", () => {
    const temporaryDirectory = mkdtempSync(
      join(tmpdir(), "claude-chatgpt-mcp-entry-"),
    );
    const modulePath = fileURLToPath(new URL("../index.ts", import.meta.url));
    const executablePath = join(temporaryDirectory, "claude-chatgpt-mcp");
    symlinkSync(modulePath, executablePath);

    try {
      expect(
        index.isMainModule(pathToFileURL(modulePath).href, executablePath),
      ).toBe(true);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

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
    const result = await index.askChatGPT("Hi", undefined, true);
    expect(result).toBe("Hello world");
    expect(execFileMock).toHaveBeenCalledWith(
      "say",
      ["Hello world"],
      expect.any(Function),
    );
  });

  it("reports say failures without failing the ChatGPT response", async () => {
    speechError = new Error("say unavailable");
    const consoleError = spyOn(console, "error").mockImplementation(() => {});

    try {
      const result = await index.askChatGPT("Hi", undefined, true);

      expect(result).toBe("Hello world");
      expect(consoleError).toHaveBeenCalledWith(
        "Error during text-to-speech:",
        speechError,
      );
    } finally {
      speechError = null;
      consoleError.mockRestore();
    }
  });
});
