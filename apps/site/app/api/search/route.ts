import { createFromSource } from "fumadocs-core/search/server";
import { source } from "@/lib/source";

// Prerendered index; the client searches it in the browser (`type: "static"` in layout.tsx).
export const revalidate = false;
export const { staticGET: GET } = createFromSource(source);
