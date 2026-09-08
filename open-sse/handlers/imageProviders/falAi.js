// Fal.ai — async submit + queue polling
import { cancelResponseBody, nowSec, sizeToAspectRatio, POLL_INTERVAL_MS, POLL_TIMEOUT_MS, requireProviderUrl } from "./_base.js";
import { PROVIDER_MEDIA } from "../../providers/index.js";

const BASE_URL = PROVIDER_MEDIA["fal-ai"]?.imageConfig?.baseUrl;

export default {
  async: true,
  buildUrl: (model) => `${BASE_URL}/${model}`,
  buildHeaders: (creds) => {
    const key = creds?.apiKey || creds?.accessToken;
    return { "Content-Type": "application/json", "Authorization": `Key ${key}` };
  },
  buildBody: (_model, body) => {
    const req = { prompt: body.prompt, num_images: body.n || 1 };
    if (body.size) req.image_size = sizeToAspectRatio(body.size);
    if (body.image) req.image_url = body.image;
    return req;
  },
  async parseResponse(response, { headers, fetch, sleep, readJson, signal }) {
    const queue = await readJson(response);
    const statusUrl = requireProviderUrl(queue.status_url, BASE_URL, "Fal status URL");
    const responseUrl = requireProviderUrl(queue.response_url, BASE_URL, "Fal response URL");
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS, signal);
      const r = await fetch(statusUrl, { headers, redirect: "error" });
      if (!r.ok) {
        cancelResponseBody(r);
        throw new Error(`Fal status ${r.status}`);
      }
      const s = await readJson(r);
      if (s.status === "COMPLETED") {
        const fr = await fetch(responseUrl, { headers, redirect: "error" });
        if (!fr.ok) {
          cancelResponseBody(fr);
          throw new Error(`Fal result ${fr.status}`);
        }
        return await readJson(fr);
      }
      if (s.status === "FAILED") throw new Error(s.error || "Fal generation failed");
    }
    throw new Error("Fal polling timeout");
  },
  normalize: (responseBody) => {
    const images = Array.isArray(responseBody.images)
      ? responseBody.images
      : (responseBody.image ? [responseBody.image] : []);
    return { created: nowSec(), data: images.map((img) => ({ url: img.url || img })) };
  },
};
