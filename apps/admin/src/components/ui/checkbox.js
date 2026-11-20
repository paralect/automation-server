"use client";
import { Checkbox as CheckboxPrimitive } from "@base-ui/react/checkbox";
import { cn } from "cn";
import { CheckIcon } from "@phosphor-icons/react";
function Checkbox({ className, ...props }) {
    return (<CheckboxPrimitive.Root data-slot="checkbox" className={cn("peer flex size-4 shrink-0 items-center justify-center rounded-[4px] border border-input bg-input/20 outline-none transition-colors focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/30 data-checked:border-primary data-checked:bg-primary data-checked:text-primary-foreground data-disabled:cursor-not-allowed data-disabled:opacity-50 dark:bg-input/30", className)} {...props}>
      <CheckboxPrimitive.Indicator data-slot="checkbox-indicator" className="flex items-center justify-center text-current">
        <CheckIcon className="size-3" weight="bold"/>
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>);
}
export { Checkbox };
