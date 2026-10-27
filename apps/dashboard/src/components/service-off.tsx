import { useState, type ReactNode } from "react";
import { Plus } from "lucide-react";
import { toast } from "sonner";
import type { Project, ServiceId } from "@mybase/shared";
import { SERVICES } from "@mybase/shared";
import { PageHeader } from "@/components/page-header";
import { CredentialsDialog, type Credentials } from "@/components/service-credentials";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";
import { errorMessage } from "@/lib/load";
import { refreshProjects } from "@/lib/projects";
import { href } from "@/lib/router";

/**
 * A service page while the service is off: what it does and a Turn on button. Shows the
 * credentials the service hands out on enable, then the page takes over.
 */
export function ServiceOff({ project, id, children }: { project: Project; id: ServiceId; children: ReactNode }) {
  const service = SERVICES.find((s) => s.id === id)!;
  const label = service.name.toLowerCase();
  const [pending, setPending] = useState(false);
  const [credentials, setCredentials] = useState<Credentials | null>(null);

  async function enable() {
    setPending(true);
    try {
      const result = await api.enableService(project.name, id);
      // Show the secret before the project refresh swaps this page for the service's.
      if (result) setCredentials(result);
      else await refreshProjects();
      toast.success(`Turned on ${label}`);
    } catch (err) {
      toast.error(`Couldn't turn on ${label}: ${errorMessage(err)}`);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <PageHeader title={service.name} breadcrumb={{ label: project.name, href: href({ page: "project", name: project.name }) }} />
      <div className="max-w-prose rounded-lg border border-dashed p-5">
        <p className="font-medium">
          {service.name} {service.name.endsWith("s") ? "are" : "is"} off for this project
        </p>
        <p className="mt-1 text-muted-foreground">{children}</p>
        <Button variant="outline" size="sm" className="mt-4" disabled={pending || credentials !== null} onClick={enable}>
          <Plus />
          {pending ? "Turning on…" : `Turn on ${label}`}
        </Button>
      </div>
      <CredentialsDialog
        credentials={credentials}
        onClose={() => {
          setCredentials(null);
          void refreshProjects();
        }}
      />
    </>
  );
}
