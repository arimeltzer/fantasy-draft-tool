import { ReactNode, useRef, useState } from "react";

interface Props {
  tip: ReactNode;
  children: ReactNode;
  /** Extra classes on the wrapper span (e.g. text alignment inherited from a grid cell). */
  className?: string;
  /** Show the dotted "this has help" underline. Defaults to true. */
  underline?: boolean;
}

/**
 * Hover/tap tooltip. Renders the popup with `position: fixed` so it never gets
 * clipped by overflow-hidden table containers; flips above the anchor when
 * there's no room below.
 */
export default function Tip({ tip, children, className = "", underline = true }: Props) {
  const anchor = useRef<HTMLSpanElement>(null);
  const [pos, setPos] = useState<{ x: number; top?: number; bottom?: number } | null>(null);

  const show = () => {
    const r = anchor.current?.getBoundingClientRect();
    if (!r) return;
    const x = Math.min(Math.max(r.left + r.width / 2, 130), window.innerWidth - 130);
    if (r.bottom > window.innerHeight - 140) {
      setPos({ x, bottom: window.innerHeight - r.top + 6 });
    } else {
      setPos({ x, top: r.bottom + 6 });
    }
  };

  return (
    <span
      ref={anchor}
      onMouseEnter={show}
      onMouseLeave={() => setPos(null)}
      onClick={() => (pos ? setPos(null) : show())}
      className={`cursor-help ${underline ? "underline decoration-dotted decoration-gray-300 underline-offset-2" : ""} ${className}`}
    >
      {children}
      {pos && (
        <span
          style={{ position: "fixed", left: pos.x, top: pos.top, bottom: pos.bottom, transform: "translateX(-50%)" }}
          className="z-[100] w-max max-w-[16rem] rounded-md border border-gray-300 bg-white shadow-lg px-2.5 py-1.5 text-xs leading-snug text-gray-600 font-sans font-normal normal-case tracking-normal whitespace-normal text-left pointer-events-none"
        >
          {tip}
        </span>
      )}
    </span>
  );
}
