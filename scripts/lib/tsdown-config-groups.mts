// Full builds stage bounded declaration programs serially; CI can select SDK roots only.
export const TSDOWN_PACKAGE_CONFIG_GROUP = "openclaw-packages";
export const TSDOWN_UNIFIED_CONFIG_GROUP = "openclaw-unified";
export const TSDOWN_UNIFIED_DTS_CONFIG_GROUPS = Array.from(
  { length: 16 },
  (_, index) => `openclaw-dts-${String(index + 1).padStart(2, "0")}`,
);
// The public SDK roots form one shared type graph. Keep them together so the
// compiler can reuse that graph instead of rebuilding it for each entry shard.
export const TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS = ["openclaw-dts-plugin-sdk"] as const;
export const TSDOWN_DECLARATION_CONFIG_GROUPS = [
  ...TSDOWN_UNIFIED_DTS_CONFIG_GROUPS,
  ...TSDOWN_PLUGIN_SDK_DTS_CONFIG_GROUPS,
] as const;
