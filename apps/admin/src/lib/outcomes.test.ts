import { describe, expect, test } from "bun:test"

import type { RepoName, RepoSyncState } from "@automation-server/api/routers/index"

import { hasResult, prBadgeState, prTiming, syncErrors, syncStatus, workRefLabel } from "./outcomes"

const repo = (name: string) => name as RepoName
const opened = "2026-11-10T08:00:00Z"

describe("pull request display", () => {
  test("an open draft reads as draft, a ready one as open", () => {
    expect(prBadgeState({ state: "open", draft: true })).toBe("draft")
    expect(prBadgeState({ state: "open", draft: false })).toBe("open")
    expect(prBadgeState({ state: "merged", mergedAt: opened })).toBe("merged")
  })

  test("timing says how long the PR took or has been open", () => {
    expect(prTiming({ createdAt: opened, lifecycle: { state: "merged", mergedAt: "2026-11-10T14:00:00Z" } }, opened)).toBe("merged in 6 h")
    expect(prTiming({ createdAt: opened, lifecycle: { state: "closed", closedAt: "2026-11-13T08:00:00Z" } }, opened)).toBe("closed after 3 d")
    expect(prTiming({ createdAt: opened, lifecycle: { state: "open", draft: true } }, "2026-11-10T08:20:00Z")).toBe("open 20 min")
  })

  test("work refs read as repo#number or the Linear identifier", () => {
    expect(workRefLabel({ kind: "github-issue", repo: repo("acme/app"), number: 123 })).toBe("acme/app#123")
    expect(workRefLabel({ kind: "linear-issue", identifier: "ENG-42" })).toBe("ENG-42")
  })
})

describe("sync status", () => {
  const state = (name: string, syncedAt: string | null, error: string | null = null): RepoSyncState => ({ repo: repo(name), syncedAt, error })

  test("the oldest sync stands for the set", () => {
    expect(syncStatus([state("a/a", "2026-11-20T10:00:00Z"), state("b/b", "2026-11-20T09:00:00Z")])).toEqual({
      kind: "synced",
      at: "2026-11-20T09:00:00Z",
    })
  })

  test("one repository never synced, or none at all, means not synced", () => {
    expect(syncStatus([state("a/a", "2026-11-20T10:00:00Z"), state("b/b", null)])).toEqual({ kind: "never" })
    expect(syncStatus([])).toEqual({ kind: "never" })
  })

  test("errors are listed per repository", () => {
    expect(syncErrors([state("a/a", null, "Bad credentials"), state("b/b", "2026-11-20T10:00:00Z")])).toEqual([
      { repo: repo("a/a"), error: "Bad credentials" },
    ])
  })
})

test("a run with no work items and no LLM calls has no result to show", () => {
  expect(hasResult({ workItems: [], llm: { calls: [] } })).toBe(false)
  expect(hasResult({ workItems: [], llm: { calls: [{}] } })).toBe(true)
  expect(hasResult({ workItems: [{}], llm: { calls: [] } })).toBe(true)
})
