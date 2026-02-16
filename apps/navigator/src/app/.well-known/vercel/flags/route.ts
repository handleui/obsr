import { createFlagsDiscoveryEndpoint, getProviderData } from "flags/next";
// biome-ignore lint/performance/noNamespaceImport: Vercel Flags SDK requires namespace import for discovery
import * as flags from "@/flags";

export const GET = createFlagsDiscoveryEndpoint(() => getProviderData(flags));
