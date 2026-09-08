// Local device TTS — macOS `say` + Windows SAPI + ffmpeg
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_TTS_RESPONSE_BYTES,
  MAX_TTS_VOICE_LIST_BYTES,
  TTS_VOICE_LIST_TIMEOUT_MS,
} from "../../config/mediaConfig.js";
import { TtsBodyTooLargeError } from "./_base.js";
import { VoiceListInvalidResponseError, VoiceListTimeoutError } from "./voiceList.js";

const execFileAsync = promisify(execFile);

const WINDOWS_TTS_TEXT_PATH_ENV = "NINEROUTER_TTS_TEXT_PATH";
const WINDOWS_TTS_VOICE_ENV = "NINEROUTER_TTS_VOICE";
const WINDOWS_TTS_WAV_PATH_ENV = "NINEROUTER_TTS_WAV_PATH";
const WINDOWS_SYNTHESIS_SCRIPT = [
  "Add-Type -AssemblyName System.Speech;",
  "$s = [System.Speech.Synthesis.SpeechSynthesizer]::new();",
  "try {",
  `$voice = [Environment]::GetEnvironmentVariable('${WINDOWS_TTS_VOICE_ENV}');`,
  "if (-not [string]::IsNullOrEmpty($voice)) { $s.SelectVoice($voice); }",
  `$wavPath = [Environment]::GetEnvironmentVariable('${WINDOWS_TTS_WAV_PATH_ENV}');`,
  `$textPath = [Environment]::GetEnvironmentVariable('${WINDOWS_TTS_TEXT_PATH_ENV}');`,
  "$text = [IO.File]::ReadAllText($textPath, [Text.Encoding]::UTF8);",
  "$s.SetOutputToWaveFile($wavPath);",
  "$s.Speak($text);",
  "} finally { $s.Dispose(); }",
].join(" ");

let _voicesCache = null;

async function fetchVoicesMac(options = {}) {
  const { stdout } = await execFileAsync("say", ["-v", "?"], {
    signal: options.signal,
    timeout: TTS_VOICE_LIST_TIMEOUT_MS,
    maxBuffer: MAX_TTS_VOICE_LIST_BYTES,
  });
  const voices = [];
  for (const line of stdout.split("\n")) {
    const m = line.match(/^([^\s].*?)\s{2,}([a-z]{2}_[A-Z]{2})/);
    if (!m) continue;
    const name = m[1].trim();
    const locale = m[2].trim();
    const lang = locale.split("_")[0];
    const country = locale.split("_")[1];
    voices.push({ id: name, name, locale, lang, country, gender: "" });
  }
  return voices;
}

async function fetchVoicesWin(options = {}) {
  const script = [
    "[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false);",
    "Add-Type -AssemblyName System.Speech;",
    "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;",
    "$s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo;",
    "[PSCustomObject]@{ Name=$v.Name; Culture=$v.Culture.Name; Gender=$v.Gender } }",
    "| ConvertTo-Json -Compress",
  ].join(" ");
  const { stdout } = await execFileAsync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", script],
    {
      windowsHide: true,
      signal: options.signal,
      timeout: TTS_VOICE_LIST_TIMEOUT_MS,
      maxBuffer: MAX_TTS_VOICE_LIST_BYTES,
    }
  );
  const raw = JSON.parse(stdout.trim() || "[]");
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.some((voice) =>
    !voice || typeof voice !== "object" || Array.isArray(voice) ||
    typeof voice.Name !== "string" || !voice.Name.trim() ||
    (voice.Culture != null && typeof voice.Culture !== "string")
  )) {
    throw new VoiceListInvalidResponseError("Windows returned an invalid local voice catalog");
  }
  return list.map((v) => {
    const culture = v.Culture || "en-US";
    const [lang, country = ""] = culture.split("-");
    const genderMap = { 1: "Male", 2: "Female", Male: "Male", Female: "Female" };
    return {
      id: v.Name, name: v.Name,
      locale: culture.replace("-", "_"),
      lang, country,
      gender: genderMap[v.Gender] || "",
    };
  });
}

export async function fetchLocalDeviceVoices(options = {}) {
  if (_voicesCache) return _voicesCache;
  if (process.platform !== "win32" && process.platform !== "darwin") return [];
  try {
    const voices = process.platform === "win32"
      ? await fetchVoicesWin(options)
      : await fetchVoicesMac(options);
    _voicesCache = voices;
    return voices;
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason || error;
    if (error?.killed === true) throw new VoiceListTimeoutError(TTS_VOICE_LIST_TIMEOUT_MS);
    throw error;
  }
}

export async function readBoundedGeneratedAudio(
  filePath,
  { signal, maxBytes = MAX_TTS_RESPONSE_BYTES } = {},
) {
  const limit = Number.isSafeInteger(maxBytes) && maxBytes > 0
    ? maxBytes
    : MAX_TTS_RESPONSE_BYTES;
  const fileInfo = await stat(filePath);
  if (!fileInfo.isFile()) throw new Error("Local TTS output is not a regular file");
  if (fileInfo.size > limit) throw new TtsBodyTooLargeError(limit, fileInfo.size);
  const bytes = await readFile(filePath, { signal });
  // Recheck after the read so replacement/growth between stat and read cannot
  // bypass the configured response cap.
  if (bytes.byteLength > limit) throw new TtsBodyTooLargeError(limit, bytes.byteLength);
  return bytes;
}

async function synthesizeLocalDevice(text, voiceId, signal, maxResponseBytes) {
  const platform = process.platform;
  if (platform !== "darwin" && platform !== "win32") {
    throw new Error(
      `Local-device TTS synthesis is unsupported on platform "${platform}"; use macOS or Windows`,
    );
  }

  const dir = await mkdtemp(join(tmpdir(), "tts-"));
  const sourcePath = join(dir, platform === "win32" ? "out.wav" : "out.aiff");
  const mp3Path = join(dir, "out.mp3");
  try {
    if (platform === "win32") {
      const textPath = join(dir, "input.txt");
      await writeFile(textPath, text, { encoding: "utf8", signal });
      await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", WINDOWS_SYNTHESIS_SCRIPT],
        {
          windowsHide: true,
          signal,
          env: {
            ...process.env,
            [WINDOWS_TTS_TEXT_PATH_ENV]: textPath,
            [WINDOWS_TTS_VOICE_ENV]: voiceId || "",
            [WINDOWS_TTS_WAV_PATH_ENV]: sourcePath,
          },
        },
      );
    } else {
      const args = voiceId
        ? ["-v", voiceId, "-o", sourcePath, text]
        : ["-o", sourcePath, text];
      await execFileAsync("say", args, { signal });
    }
    await execFileAsync(
      "ffmpeg",
      ["-y", "-i", sourcePath, "-codec:a", "libmp3lame", "-qscale:a", "4", mp3Path],
      { signal },
    );
    const buf = await readBoundedGeneratedAudio(mp3Path, {
      signal,
      maxBytes: maxResponseBytes,
    });
    return buf.toString("base64");
  } finally {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (error) {
      // Temp cleanup is secondary to an already generated/validated result and
      // must not turn it into a retryable provider failure.
      console.error("[LocalDeviceTTS] Failed to clean temporary output:", error?.message || error);
    }
  }
}

export default {
  noAuth: true,
  async synthesize(text, model, _credentials, _responseFormat, options = {}) {
    const base64 = await synthesizeLocalDevice(
      text,
      model,
      options.signal,
      options.maxResponseBytes,
    );
    return { base64, format: "mp3" };
  },
};
