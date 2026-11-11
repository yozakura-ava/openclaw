import { CUSTOM_LOCAL_AUTH_MARKER } from "openclaw/plugin-sdk/provider-auth";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import { LMSTUDIO_DEFAULT_API_KEY_ENV_VAR, LMSTUDIO_PROVIDER_ID } from "./src/defaults.js";
<<<<<<< HEAD
=======
import { getUnlistedLmstudioConfiguredModelIds } from "./src/models.js";
>>>>>>> 97b6e87616f
import {
  hasLmstudioAuthorizationHeader,
  resolveLmstudioProviderAuthMode,
} from "./src/provider-auth.js";

export default {
  id: LMSTUDIO_PROVIDER_ID,
  label: "LM Studio",
  docsPath: "/providers/lmstudio",
  envVars: [LMSTUDIO_DEFAULT_API_KEY_ENV_VAR],
  auth: [],
  catalog: {
    order: "late",
<<<<<<< HEAD
    run: async (ctx) => {
      const { discoverLmstudioProvider } = await import("./src/setup.js");
=======
    getUnlistedConfiguredModelIds: getUnlistedLmstudioConfiguredModelIds,
    run: async (ctx) => {
      const { discoverLmstudioProvider } = await import("./src/catalog.js");
>>>>>>> 97b6e87616f
      return await discoverLmstudioProvider(ctx, { discoveryMode: "strict" });
    },
  },
  resolveSyntheticAuth: ({ providerConfig }) => {
    if (
      !providerConfig ||
      resolveLmstudioProviderAuthMode(providerConfig.apiKey) ||
      hasLmstudioAuthorizationHeader(providerConfig.headers)
    ) {
      return undefined;
    }
    return {
      apiKey: CUSTOM_LOCAL_AUTH_MARKER,
      source: "models.providers.lmstudio (synthetic local key)",
      mode: "api-key",
    };
  },
} satisfies ProviderPlugin;
