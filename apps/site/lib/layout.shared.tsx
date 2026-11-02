import { MYBASE_VERSION } from "@mybase/shared";
import type { BaseLayoutProps } from "fumadocs-ui/layouts/shared";
import { Logo } from "@/components/logo";
import { githubUrl } from "./shared";

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="flex items-center gap-2">
          <Logo />
          <span className="font-semibold tracking-tight">mybase</span>
          <span className="rounded border border-fd-border px-1.5 py-0.5 font-mono text-[11px] leading-none text-fd-muted-foreground">
            v{MYBASE_VERSION}
          </span>
        </span>
      ),
    },
    githubUrl,
  };
}
