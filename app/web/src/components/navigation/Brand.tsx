/**
 * Brand — authorized InterviewKickstart logo on a neutral plate + HELLO
 * wordmark.
 *
 * Rule (mission): the brand logo is NEVER CSS-inverted; it sits on its own
 * white plate (`bg-plate`) so its original colors survive on the desk. The logo file is
 * byte-identical to the authorized source
 * (`SIP dashboard/public/ik-logo.png`, md5 b3440bdbd91a65946c05928ba7f74e8a).
 */

interface BrandProps {
  /** When true (mobile top bar), hide the tagline. */
  compact?: boolean;
}

export function Brand({ compact = false }: BrandProps) {
  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        aria-hidden="true"
        className="flex h-9 w-9 shrink-0 items-center justify-center overflow-hidden rounded-control border border-line-strong bg-plate"
      >
        {/* Neutral plate — original brand colors preserved, never inverted. */}
        <img
          src="/ik-logo.png"
          alt=""
          className="h-7 w-7 object-contain"
          draggable={false}
        />
      </div>
      <div className="min-w-0">
        <p className="truncate text-section text-ink">
          HELLO
        </p>
        {!compact && (
          // Short enough to never truncate in the 248px rail: the full name
          // ("Talent Workspace & Mission Control") was cut to "Mission Co…".
          <p className="truncate text-meta font-medium text-ink-tertiary">Recruiting workspace</p>
        )}
      </div>
    </div>
  );
}
