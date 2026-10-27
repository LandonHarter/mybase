import { useState } from "react";
import { CRON_DEFAULTS, type CronJob, type CronJobSpec } from "@mybase/shared";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Form fields as typed: everything is a string until submit. */
export interface JobFields {
  name: string;
  schedule: string;
  url: string;
  timezone: string;
  retries: string;
  timeoutSec: string;
  payload: string;
}

export const emptyFields = (): JobFields => ({
  name: "",
  schedule: "",
  url: "",
  timezone: CRON_DEFAULTS.timezone,
  retries: String(CRON_DEFAULTS.retries),
  timeoutSec: String(CRON_DEFAULTS.timeoutMs / 1000),
  payload: "",
});

export const fieldsOf = (job: CronJob): JobFields => ({
  name: job.name,
  schedule: job.schedule,
  url: job.url,
  timezone: job.timezone,
  retries: String(job.retries),
  timeoutSec: String(job.timeoutMs / 1000),
  payload: job.payload === null ? "" : JSON.stringify(job.payload, null, 2),
});

/** Turns the fields into a request body, or returns the message to show. The API checks the rest. */
export function specOf(fields: JobFields): { spec: CronJobSpec & { name: string } } | { error: string } {
  let payload: unknown = null;
  if (fields.payload.trim()) {
    try {
      payload = JSON.parse(fields.payload);
    } catch {
      return { error: "Payload must be valid JSON, or empty." };
    }
  }
  const timeoutSec = Number(fields.timeoutSec);
  return {
    spec: {
      name: fields.name.trim(),
      schedule: fields.schedule.trim(),
      url: fields.url.trim(),
      timezone: fields.timezone.trim() || CRON_DEFAULTS.timezone,
      retries: Number(fields.retries),
      timeoutMs: Number.isFinite(timeoutSec) ? Math.round(timeoutSec * 1000) : NaN,
      payload,
    },
  };
}

/** The job's fields. `readOnly` for jobs defined in code. */
export function CronJobForm({
  fields,
  onChange,
  readOnly = false,
  autoFocus = false,
}: {
  fields: JobFields;
  onChange: (fields: JobFields) => void;
  readOnly?: boolean;
  autoFocus?: boolean;
}) {
  const set = (key: keyof JobFields) => (e: { currentTarget: { value: string } }) => onChange({ ...fields, [key]: e.currentTarget.value });
  const [zones] = useState(() => Intl.supportedValuesOf("timeZone"));
  // Placeholders would read as values in a read-only form.
  const hint = (text: string) => (readOnly ? undefined : text);

  return (
    <div className="grid gap-4">
      <div className="grid content-start gap-1.5">
        <Label htmlFor="job-name">Name</Label>
        <Input
          id="job-name"
          value={fields.name}
          onChange={set("name")}
          readOnly={readOnly}
          autoFocus={autoFocus}
          placeholder={hint("cleanup")}
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground">Sent as the job name, so your handler can tell jobs apart.</p>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <Label htmlFor="job-schedule">Schedule</Label>
          <Input
            id="job-schedule"
            value={fields.schedule}
            onChange={set("schedule")}
            readOnly={readOnly}
            placeholder={hint("0 3 * * *")}
            className="font-mono"
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-muted-foreground">Minute, hour, day, month, weekday.</p>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="job-tz">Time zone</Label>
          <Input id="job-tz" list="job-tz-list" value={fields.timezone} onChange={set("timezone")} readOnly={readOnly} autoComplete="off" />
          <datalist id="job-tz-list">
            {["UTC", ...zones].map((z) => (
              <option key={z} value={z} />
            ))}
          </datalist>
        </div>
      </div>
      <div className="grid content-start gap-1.5">
        <Label htmlFor="job-url">URL</Label>
        <Input
          id="job-url"
          type="url"
          value={fields.url}
          onChange={set("url")}
          readOnly={readOnly}
          placeholder={hint("https://app.example.com/api/cron")}
          className="font-mono"
          autoComplete="off"
          spellCheck={false}
        />
        <p className="text-muted-foreground">Gets a signed POST. It must be reachable from the mybase server.</p>
      </div>
      <div className="grid items-start gap-4 sm:grid-cols-2">
        <div className="grid content-start gap-1.5">
          <Label htmlFor="job-retries">Retries</Label>
          <Input id="job-retries" type="number" min={0} max={5} value={fields.retries} onChange={set("retries")} readOnly={readOnly} />
          <p className="text-muted-foreground">After a timeout, 429, or 5xx.</p>
        </div>
        <div className="grid content-start gap-1.5">
          <Label htmlFor="job-timeout">Timeout (seconds)</Label>
          <Input id="job-timeout" type="number" min={1} max={120} value={fields.timeoutSec} onChange={set("timeoutSec")} readOnly={readOnly} />
        </div>
      </div>
      <div className="grid content-start gap-1.5">
        <Label htmlFor="job-payload">Payload (optional)</Label>
        <Textarea
          id="job-payload"
          value={fields.payload}
          onChange={set("payload")}
          readOnly={readOnly}
          placeholder={hint('{ "olderThanDays": 30 }')}
          className="min-h-20 font-mono text-xs md:text-xs"
          spellCheck={false}
        />
        <p className="text-muted-foreground">JSON your handler gets as run.payload.</p>
      </div>
    </div>
  );
}
