// Black Forest Labs (FLUX) — async submit + polling_url
import { cancelResponseBody, nowSec, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, requireProviderUrl } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["black-forest-labs"]?.imageConfig?.baseUrl;

export default {
  async: true,
  buildUrl: (model) => `${BASE_URL}/${model}`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", "x-key": key };
  },
  buildBody: (_model, body) => {
    const req = { prompt: body.prompt };
    if (body.size) {
      const [w, h] = body.size.split("x").map(Number);
      if (w) req.width = w;
      if (h) req.height = h;
    }
    if (body.image) req.image_prompt = body.image;
    return req;
  },
  async parseResponse(response, { headers, fetch, sleep, readJson, signal }) {
    const data = await readJson(response);
    const pollingUrl = requireProviderUrl(data.polling_url, BASE_URL, "BFL polling URL");
    if (!pollingUrl) throw new Error("BFL: no polling_url returned");
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS, signal);
      const r = await fetch(pollingUrl, {
        headers: { "x-key": headers["x-key"], "Accept": "application/json" },
        redirect: "error",
      });
      if (!r.ok) {
        cancelResponseBody(r);
        throw new Error(`BFL status ${r.status}`);
      }
      const s = await readJson(r);
      if (s.status === "Ready") return s;
      if (s.status === "Error" || s.status === "Failed") throw new Error(s.error || "BFL generation failed");
    }
    throw new Error("BFL polling timeout");
  },
  normalize: (responseBody) => {
    const sample = responseBody.result?.sample;
    if (sample) return { created: nowSec(), data: [{ url: sample }] };
    return { created: nowSec(), data: [] };
  },
};
