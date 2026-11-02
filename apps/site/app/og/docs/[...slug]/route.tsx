import { generateOGImage } from "fumadocs-ui/og";
import { notFound } from "next/navigation";
import { appName, getPageImageUrl } from "@/lib/shared";
import { source } from "@/lib/source";

export const revalidate = false;

export async function GET(_req: Request, { params }: RouteContext<"/og/docs/[...slug]">) {
  const { slug } = await params;
  const page = source.getPage(slug.slice(0, -1));
  if (!page) notFound();

  // Dashboard moss accent (dark), in sRGB: the image renderer has no oklch.
  return generateOGImage({
    title: page.data.title,
    description: page.data.description,
    site: appName,
    primaryColor: "rgba(111, 192, 130, 0.35)",
    primaryTextColor: "#6fc082",
  });
}

export function generateStaticParams() {
  return source.getPages().map((page) => ({ slug: getPageImageUrl(page).segments }));
}
