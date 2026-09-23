import manifest from "../package.json" with { type: "json" };

export const PRODUCT_VERSION: string = manifest.version;
