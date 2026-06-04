import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Minimal scroll container. The full shadcn ScrollArea wraps Radix's
 * scroll-area primitive; for this MVP a styled native-overflow div is enough
 * and avoids pulling in another radix dependency.
 */
const ScrollArea = React.forwardRef<
  HTMLDivElement,
  React.HTMLAttributes<HTMLDivElement>
>(({ className, children, ...props }, ref) => (
  <div
    ref={ref}
    className={cn("relative overflow-y-auto", className)}
    {...props}
  >
    {children}
  </div>
));
ScrollArea.displayName = "ScrollArea";

export { ScrollArea };
