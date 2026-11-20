import { useNavigate } from "@tanstack/react-router";
import { CaretUpDownIcon, SignOutIcon } from "@phosphor-icons/react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger, } from "@/components/ui/dropdown-menu";
import { SidebarMenu, SidebarMenuButton, SidebarMenuItem, useSidebar, } from "@/components/ui/sidebar";
import { logoutFn } from "@/lib/auth.functions";
export function NavUser({ user }) {
    const { isMobile } = useSidebar();
    const navigate = useNavigate();
    async function logout() {
        await logoutFn();
        await navigate({ to: "/login" });
    }
    return (<SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger render={<SidebarMenuButton size="lg" className="aria-expanded:bg-muted"/>}>
            <Avatar>
              <AvatarFallback>{user.email.slice(0, 2).toUpperCase()}</AvatarFallback>
            </Avatar>
            <div className="grid flex-1 text-left text-sm leading-tight">
              <span className="truncate font-medium">Admin</span>
              <span className="truncate text-xs">{user.email}</span>
            </div>
            <CaretUpDownIcon className="ml-auto size-4"/>
          </DropdownMenuTrigger>
          <DropdownMenuContent className="w-fit" side={isMobile ? "bottom" : "right"} align="end" sideOffset={4}>
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">{user.email}</DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={logout}>
              <SignOutIcon />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>);
}
