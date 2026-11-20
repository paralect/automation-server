"use client";
import * as React from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { cn } from "cn";
import { Button } from "@/components/ui/button";
import { XIcon } from "@phosphor-icons/react";
function Dialog({ ...props }) {
    return <DialogPrimitive.Root data-slot="dialog" {...props}/>;
}
function DialogTrigger({ ...props }) {
    return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props}/>;
}
function DialogClose({ ...props }) {
    return <DialogPrimitive.Close data-slot="dialog-close" {...props}/>;
}
function DialogContent({ className, children, showCloseButton = true, ...props }) {
    return (<DialogPrimitive.Portal data-slot="dialog-portal">
      <DialogPrimitive.Backdrop data-slot="dialog-overlay" className="fixed inset-0 z-50 bg-black/80 transition-opacity duration-150 data-ending-style:opacity-0 data-starting-style:opacity-0 supports-backdrop-filter:backdrop-blur-xs"/>
      <DialogPrimitive.Popup data-slot="dialog-content" className={cn("fixed top-1/2 left-1/2 z-50 flex max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-lg -translate-x-1/2 -translate-y-1/2 flex-col overflow-hidden rounded-lg bg-popover text-xs/relaxed text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition duration-150 data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0", className)} {...props}>
        {children}
        {showCloseButton && (<DialogPrimitive.Close data-slot="dialog-close" render={<Button variant="ghost" className="absolute top-3 right-3" size="icon-sm"/>}>
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>)}
      </DialogPrimitive.Popup>
    </DialogPrimitive.Portal>);
}
function DialogHeader({ className, ...props }) {
    return <div data-slot="dialog-header" className={cn("flex flex-col gap-1 border-b p-4 pr-12", className)} {...props}/>;
}
function DialogBody({ className, ...props }) {
    return <div data-slot="dialog-body" className={cn("flex-1 overflow-y-auto p-4", className)} {...props}/>;
}
function DialogFooter({ className, ...props }) {
    return <div data-slot="dialog-footer" className={cn("flex flex-col gap-3 border-t p-4", className)} {...props}/>;
}
function DialogTitle({ className, ...props }) {
    return (<DialogPrimitive.Title data-slot="dialog-title" className={cn("font-heading text-sm font-medium text-foreground", className)} {...props}/>);
}
function DialogDescription({ className, ...props }) {
    return (<DialogPrimitive.Description data-slot="dialog-description" className={cn("text-xs/relaxed text-muted-foreground", className)} {...props}/>);
}
export { Dialog, DialogTrigger, DialogClose, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription };
