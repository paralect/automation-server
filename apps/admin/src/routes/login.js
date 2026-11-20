import { createFileRoute, redirect } from "@tanstack/react-router";
import { LoginForm } from "@/components/login-form";
import { getSessionFn } from "@/lib/auth.functions";
export const Route = createFileRoute("/login")({
    beforeLoad: async () => {
        if (await getSessionFn())
            throw redirect({ to: "/" });
    },
    component: LoginPage,
});
function LoginPage() {
    return (<div className="flex min-h-svh w-full items-center justify-center p-6 md:p-10">
      <div className="w-full max-w-sm">
        <LoginForm />
      </div>
    </div>);
}
