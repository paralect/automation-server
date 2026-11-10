import { MoonIcon, SunIcon } from "@phosphor-icons/react"

import { Button } from "@/components/ui/button"

export function ThemeToggle() {
  function toggle() {
    const dark = document.documentElement.classList.toggle("dark")
    try {
      localStorage.setItem("theme", dark ? "dark" : "light")
    } catch {}
  }

  return (
    <Button variant="ghost" size="icon" onClick={toggle} aria-label="Toggle dark mode">
      <SunIcon className="hidden dark:block" />
      <MoonIcon className="dark:hidden" />
    </Button>
  )
}
