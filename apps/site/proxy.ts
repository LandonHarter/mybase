import { isMarkdownPreferred, rewritePath } from "fumadocs-core/negotiation";
import { type NextRequest, NextResponse } from "next/server";
import { docsContentRoute, docsRoute } from "@/lib/shared";

// `/docs/<slug>.md` (same URLs as an instance's API) and `Accept: text/markdown` get the raw page.
const { rewrite: rewriteDocs } = rewritePath(`${docsRoute}{/*path}`, `${docsContentRoute}{/*path}/content.md`);
const { rewrite: rewriteSuffix } = rewritePath(`${docsRoute}{/*path}.md`, `${docsContentRoute}{/*path}/content.md`);

export default function proxy(request: NextRequest) {
  const suffixed = rewriteSuffix(request.nextUrl.pathname);
  if (suffixed) return NextResponse.rewrite(new URL(suffixed, request.nextUrl));

  if (isMarkdownPreferred(request)) {
    const preferred = rewriteDocs(request.nextUrl.pathname);
    if (preferred) return NextResponse.rewrite(new URL(preferred, request.nextUrl), { headers: { Vary: "Accept" } });
  }

  return NextResponse.next();
}
