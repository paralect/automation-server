import { useState } from "react"
import { useNavigate } from "@tanstack/react-router"
import { cn } from "cn"

import { Button } from "@/components/ui/button"
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card"
import { Field, FieldError, FieldGroup, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { loginFn } from "@/lib/auth.functions"

export function LoginForm({ className, ...props }: React.ComponentProps<"div">) {
  const navigate = useNavigate()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const form = new FormData(event.currentTarget)
    setPending(true)
    setError(null)
    try {
      const result = await loginFn({
        data: { email: String(form.get("email")), password: String(form.get("password")) },
      })
      if (result.ok) await navigate({ to: "/" })
      else setError(result.error)
    } catch {
      setError("Could not reach the admin server. Try again.")
    } finally {
      setPending(false)
    }
  }

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          <CardTitle>Automation Server</CardTitle>
          <CardDescription>Log in to the admin dashboard</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit}>
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="email">Email</FieldLabel>
                <Input id="email" name="email" type="email" autoComplete="username" required />
              </Field>
              <Field>
                <FieldLabel htmlFor="password">Password</FieldLabel>
                <Input
                  id="password"
                  name="password"
                  type="password"
                  autoComplete="current-password"
                  required
                />
              </Field>
              {error && <FieldError role="alert">{error}</FieldError>}
              <Field>
                <Button type="submit" disabled={pending}>
                  {pending ? "Logging in..." : "Login"}
                </Button>
              </Field>
            </FieldGroup>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
