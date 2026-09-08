// Central config for remote-media fetching security limits.

// Max bytes accepted from a remote image fetch (reject larger to prevent memory DoS).
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024; // 10MB

// Fetch timeout for remote media.
export const FETCH_TIMEOUT_MS = 10000;

function positiveIntegerEnv(name, fallback) {
  const parsed = Number.parseInt(process.env[name] || "", 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

// Image generation can include a long-running provider job, but every request
// still needs one absolute deadline covering submit, polling and response reads.
export const IMAGE_GENERATION_TIMEOUT_MS = positiveIntegerEnv(
  "IMAGE_GENERATION_TIMEOUT_MS",
  120_000,
);

// Provider JSON/SSE can contain base64 images. Keep enough room for normal
// generations and progressive previews while preventing unbounded buffering.
export const MAX_IMAGE_RESPONSE_BYTES = positiveIntegerEnv(
  "MAX_IMAGE_RESPONSE_BYTES",
  64 * 1024 * 1024,
);
export const MAX_IMAGE_SSE_EVENTS = positiveIntegerEnv(
  "MAX_IMAGE_SSE_EVENTS",
  10_000,
);

// TTS responses are fully buffered before the router can return either the
// binary body or its JSON/base64 wrapper. Bound both elapsed time and memory;
// the stall timeout catches a peer that sends headers (or one chunk) and then
// leaves the response open indefinitely.
export const TTS_GENERATION_TIMEOUT_MS = positiveIntegerEnv(
  "TTS_GENERATION_TIMEOUT_MS",
  120_000,
);
export const TTS_BODY_STALL_TIMEOUT_MS = positiveIntegerEnv(
  "TTS_BODY_STALL_TIMEOUT_MS",
  30_000,
);
export const MAX_TTS_RESPONSE_BYTES = positiveIntegerEnv(
  "MAX_TTS_RESPONSE_BYTES",
  64 * 1024 * 1024,
);

// Voice catalogs are control-plane JSON and should stay small. Give their
// header and body reads one shared deadline and reject unexpectedly large
// catalogs before they can be buffered by a dashboard/API request.
export const TTS_VOICE_LIST_TIMEOUT_MS = positiveIntegerEnv(
  "TTS_VOICE_LIST_TIMEOUT_MS",
  15_000,
);
export const TTS_VOICE_LIST_STALL_TIMEOUT_MS = positiveIntegerEnv(
  "TTS_VOICE_LIST_STALL_TIMEOUT_MS",
  5_000,
);
export const MAX_TTS_VOICE_LIST_BYTES = positiveIntegerEnv(
  "MAX_TTS_VOICE_LIST_BYTES",
  4 * 1024 * 1024,
);

// Magic-byte signatures -> mime. Each entry: { sig:[bytes], offset, mime }.
// offset>0 for containers where the signature is not at byte 0 (e.g. webp).
export const IMAGE_SIGNATURES = [
  { sig: [0x89, 0x50, 0x4e, 0x47], offset: 0, mime: "image/png" },
  { sig: [0xff, 0xd8, 0xff], offset: 0, mime: "image/jpeg" },
  { sig: [0x47, 0x49, 0x46, 0x38], offset: 0, mime: "image/gif" },
  { sig: [0x52, 0x49, 0x46, 0x46], offset: 0, mime: "image/webp", verifyWebp: true },
  { sig: [0x42, 0x4d], offset: 0, mime: "image/bmp" },
];

// Hostnames/IPs that must never be fetched (SSRF guard for loopback + cloud metadata).
export const BLOCKED_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "0.0.0.0",
  "::1",
  "169.254.169.254", // AWS/GCP/Azure IMDS
  "metadata.google.internal",
]);
