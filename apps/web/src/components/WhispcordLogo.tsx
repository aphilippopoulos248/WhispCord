/* eslint-disable @next/next/no-img-element -- a static SVG gains nothing from next/image. */

/** Whispcord mark. The artwork lives in app/icon.svg (also the favicon); assets/ holds the source copy. */
export function WhispcordLogo({ className }: { className?: string }) {
  return <img src="/icon.svg" alt="" aria-hidden width={32} height={32} className={className} />;
}
