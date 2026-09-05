/**
 * Brand — authorized InterviewKickstart logo on a neutral plate + HELLO
 * wordmark.
 *
 * Rule (mission): the brand logo is NEVER CSS-inverted; it sits on a white
 * plate so its original colors survive on any ground. The logo file is
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
        className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[12px] bg-white shadow-pill"
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
        <p className="truncate text-[15px] font-semibold tracking-[-0.01em] text-ink">
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
