/**
 * Brand — authorized InterviewKickstart logo on a neutral plate + HELLO
 * wordmark.
 *
 * Dark-mode rule (mission): the brand logo is NEVER CSS-inverted; it sits on
 * a neutral plate (`bg-white/90` ring) so its original colors survive in both
 * themes. The logo file is byte-identical to the authorized source
 * (`SIP dashboard/public/ik-logo.png`, md5 b3440bdbd91a65946c05928ba7f74e8a).
 */

interface BrandProps {
  /** When true (mobile drawer), render a close affordance separately. */
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        aria-hidden="true"
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-white ring-1 ring-line shadow-sm"
      >
        {/* Neutral plate — original brand colors preserved, never inverted. */}
        <img
          src="/ik-logo.png"
          alt=""
          className="h-8 w-8 object-contain"
          draggable={false}
        />
      </div>
      <div className="min-w-0">
        <p className="truncate text-[15px] font-bold tracking-tight text-ink">
          HELLO
        </p>
        {!compact && (
          <p className="truncate text-[11px] font-medium text-ink-tertiary">
            Talent Workspace &amp; Mission Control
          </p>
        )}
      </div>
    </div>
  );
}
