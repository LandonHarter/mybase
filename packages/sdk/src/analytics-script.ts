// The script-tag build of the analytics client, served by mybase at /analytics.js:
//
//   <script defer src="https://mybase.example.com/analytics.js" data-project="shop" data-key="mba_…"></script>
//
// Optional attributes: data-api (default: where the script came from), data-errors="false",
// data-pageviews="false", data-keep-query, data-respect-dnt. Then, anywhere on the page:
//   mybase.track("signup", { plan: "pro" })
import { createAnalytics, type Analytics } from "./analytics";

declare global {
  interface Window {
    mybase?: { analytics?: Analytics; track?: Analytics["track"]; pageview?: Analytics["pageview"]; captureError?: Analytics["captureError"] };
  }
}

const script = document.currentScript as HTMLScriptElement | null;
const data = script?.dataset ?? {};
const off = (value: string | undefined) => value === "false" || value === "0";

if (!data.project || !data.key) {
  console.warn("mybase analytics: add data-project and data-key to the script tag");
} else if (!window.mybase?.analytics) {
  const analytics = createAnalytics({
    apiUrl: data.api || new URL(script!.src, location.href).origin,
    project: data.project,
    key: data.key,
    autoPageviews: !off(data.pageviews),
    captureErrors: !off(data.errors),
    keepQuery: data.keepQuery !== undefined && !off(data.keepQuery),
    respectDoNotTrack: data.respectDnt !== undefined && !off(data.respectDnt),
  });
  window.mybase = {
    ...window.mybase,
    analytics,
    track: analytics.track,
    pageview: analytics.pageview,
    captureError: analytics.captureError,
  };
}
