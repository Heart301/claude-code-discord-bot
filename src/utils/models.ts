const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";
const CACHE_TTL_MS = 5 * 60 * 1000;

export interface AnthropicModel {
  id: string;
  displayName: string;
}

const cache = new Map<string, { models: AnthropicModel[]; expiresAt: number }>();

async function fetchAvailableModels(apiKey: string): Promise<AnthropicModel[]> {
  const models: AnthropicModel[] = [];
  let afterId: string | undefined;

  do {
    const url = new URL(ANTHROPIC_MODELS_URL);
    url.searchParams.set("limit", "100");
    if (afterId) url.searchParams.set("after_id", afterId);

    const response = await fetch(url, {
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
      },
    });

    if (!response.ok) {
      throw new Error(`Anthropic Models API returned ${response.status}`);
    }

    const body = (await response.json()) as {
      data: { id: string; display_name: string }[];
      has_more: boolean;
      last_id: string | null;
    };

    models.push(...body.data.map((m) => ({ id: m.id, displayName: m.display_name })));
    afterId = body.has_more && body.last_id ? body.last_id : undefined;
  } while (afterId);

  return models;
}

// Cached per API key so opening the /model dropdown repeatedly doesn't
// re-hit the Anthropic API every time.
export async function getAvailableModels(apiKey: string): Promise<AnthropicModel[]> {
  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.models;
  }

  const models = await fetchAvailableModels(apiKey);
  cache.set(apiKey, { models, expiresAt: Date.now() + CACHE_TTL_MS });
  return models;
}
