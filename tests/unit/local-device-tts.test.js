import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  execFile: vi.fn(),
  mkdtemp: vi.fn(),
  readFile: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: mocks.execFile }));
vi.mock("node:fs/promises", () => ({
  mkdtemp: mocks.mkdtemp,
  readFile: mocks.readFile,
  rm: mocks.rm,
  stat: mocks.stat,
  writeFile: mocks.writeFile,
}));

import localDevice from "../../open-sse/handlers/ttsProviders/localDevice.js";

const originalPlatform = process.platform;

function setPlatform(platform) {
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
}

function succeedExecFile(_file, _args, _options, callback) {
  callback(null, "", "");
}

describe("local-device TTS synthesis", () => {
  beforeEach(() => {
    mocks.execFile.mockReset().mockImplementation(succeedExecFile);
    mocks.mkdtemp.mockReset().mockResolvedValue("C:\\safe-temp\\tts-fixed");
    mocks.readFile.mockReset().mockResolvedValue(Buffer.from("mp3-data"));
    mocks.rm.mockReset().mockResolvedValue(undefined);
    mocks.stat.mockReset().mockResolvedValue({ isFile: () => true, size: 8 });
    mocks.writeFile.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    setPlatform(originalPlatform);
    vi.restoreAllMocks();
  });

  it("uses macOS say followed by ffmpeg", async () => {
    setPlatform("darwin");

    await localDevice.synthesize("hello", "Samantha");

    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    expect(mocks.execFile.mock.calls[0][0]).toBe("say");
    expect(mocks.execFile.mock.calls[0][1]).toEqual([
      "-v", "Samantha", "-o", expect.stringMatching(/out\.aiff$/), "hello",
    ]);
    expect(mocks.execFile.mock.calls[1][0]).toBe("ffmpeg");
    expect(mocks.execFile.mock.calls[1][1]).toContainEqual(expect.stringMatching(/out\.aiff$/));
  });

  it("uses a fixed Windows SAPI script and a UTF-8 file for large or special text", async () => {
    setPlatform("win32");
    const text = `${"x".repeat(40_000)}\0'; Remove-Item -Recurse C:\\important; #`;
    const voice = 'Voice"; Start-Process calc; #';

    await localDevice.synthesize(text, voice);

    expect(mocks.execFile).toHaveBeenCalledTimes(2);
    const [program, args, options] = mocks.execFile.mock.calls[0];
    expect(program).toBe("powershell.exe");
    expect(args.slice(0, 5)).toEqual([
      "-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command",
    ]);
    expect(args.join(" ")).not.toContain(text);
    expect(args.join(" ")).not.toContain(voice);
    expect(args.join(" ")).not.toContain("C:\\safe-temp\\tts-fixed");
    expect(args[5]).toContain("[IO.File]::ReadAllText");
    expect(args[5]).toContain("$s.SetOutputToWaveFile");
    expect(options).toMatchObject({ windowsHide: true });
    expect(options.env).toMatchObject({
      NINEROUTER_TTS_TEXT_PATH: expect.stringMatching(/input\.txt$/),
      NINEROUTER_TTS_VOICE: voice,
      NINEROUTER_TTS_WAV_PATH: expect.stringMatching(/out\.wav$/),
    });
    expect(Object.values(options.env)).not.toContain(text);
    expect(mocks.writeFile).toHaveBeenCalledWith(
      expect.stringMatching(/input\.txt$/),
      text,
      { encoding: "utf8", signal: undefined },
    );

    expect(mocks.execFile.mock.calls[1][0]).toBe("ffmpeg");
    expect(mocks.execFile.mock.calls[1][1]).toContainEqual(expect.stringMatching(/out\.wav$/));
  });

  it("removes the temporary directory when synthesis fails", async () => {
    setPlatform("win32");
    const synthesisError = new Error("SAPI failed");
    mocks.execFile.mockImplementationOnce((_file, _args, _options, callback) => {
      callback(synthesisError, "", "");
    });

    await expect(localDevice.synthesize("hello", "Test voice")).rejects.toBe(synthesisError);

    expect(mocks.execFile).toHaveBeenCalledOnce();
    expect(mocks.rm).toHaveBeenCalledWith(
      "C:\\safe-temp\\tts-fixed",
      { recursive: true, force: true },
    );
  });

  it("preserves generated audio when temporary cleanup fails", async () => {
    setPlatform("win32");
    const cleanupError = new Error("directory busy");
    mocks.rm.mockRejectedValue(cleanupError);
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(localDevice.synthesize("hello", "Test voice")).resolves.toEqual({
      base64: Buffer.from("mp3-data").toString("base64"),
      format: "mp3",
    });

    expect(consoleError).toHaveBeenCalledWith(
      "[LocalDeviceTTS] Failed to clean temporary output:",
      cleanupError.message,
    );
  });

  it("passes the abort signal to file creation, SAPI, ffmpeg, and output reading", async () => {
    setPlatform("win32");
    const controller = new AbortController();

    await localDevice.synthesize(
      "hello",
      "Test voice",
      undefined,
      undefined,
      { signal: controller.signal },
    );

    expect(mocks.writeFile.mock.calls[0][2].signal).toBe(controller.signal);
    expect(mocks.execFile.mock.calls[0][2].signal).toBe(controller.signal);
    expect(mocks.execFile.mock.calls[1][2].signal).toBe(controller.signal);
    expect(mocks.readFile.mock.calls[0][1].signal).toBe(controller.signal);
  });

  it("fails clearly before creating files on unsupported platforms", async () => {
    setPlatform("linux");

    await expect(localDevice.synthesize("hello", "voice"))
      .rejects.toThrow('unsupported on platform "linux"');

    expect(mocks.mkdtemp).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.rm).not.toHaveBeenCalled();
  });
});
