import { useEffect, useRef, useState, type ReactNode } from "react";
import { TldrawLicenseRequired } from "./tldraw-license-required";

export function TldrawLicenseBoundary({ children }: { children: ReactNode }) {
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [rejected, setRejected] = useState(false);

  useEffect(() => {
    const root = rootRef.current;
    if (root === null) return;
    const check = () => {
      if (root.querySelector('[data-testid="tl-license-expired"]') !== null) {
        setRejected(true);
      }
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={rootRef} className="relative h-full min-h-0 w-full">
      {rejected ? <TldrawLicenseRequired rejected /> : children}
    </div>
  );
}
