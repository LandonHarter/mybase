/** Stacked-slices mark: one shared base, a slice per project. Uses the accent color. */
export function Logo({ className = "size-5" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" aria-hidden="true" className={className}>
      <rect x="3" y="15" width="18" height="5" rx="1.5" className="fill-fd-primary" />
      <rect x="3" y="9.5" width="18" height="4" rx="1.5" className="fill-fd-primary/60" />
      <rect x="3" y="4" width="18" height="4" rx="1.5" className="fill-fd-primary/30" />
    </svg>
  );
}
