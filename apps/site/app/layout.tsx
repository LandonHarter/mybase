import "@fontsource-variable/hanken-grotesk";
import "@fontsource-variable/jetbrains-mono";
import { RootProvider } from "fumadocs-ui/provider/next";
import type { Metadata } from "next";
import Script from "next/script";
import { analytics, siteUrl } from "@/lib/shared";
import "./global.css";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: { default: "mybase: your own backend, on your own hardware", template: "%s | mybase" },
  description:
    "Self-hosted backend platform. Postgres, S3 storage, cron, queues, cache, auth, realtime, and more for every project, on one Docker host. Even a Raspberry Pi.",
};

export default function Layout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex min-h-screen flex-col">
        <RootProvider search={{ options: { type: "static" } }}>{children}</RootProvider>
        {analytics.url && analytics.project && analytics.key && (
          <Script src={`${analytics.url}/analytics.js`} data-project={analytics.project} data-key={analytics.key} strategy="afterInteractive" />
        )}
      </body>
    </html>
  );
}
