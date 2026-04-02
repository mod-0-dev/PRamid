import { describe, expect, test } from "bun:test"
import { parseOwnerRepo } from "./git-ops.ts"

describe("parseOwnerRepo", () => {
  test("parses SSH URL with .git suffix", () => {
    expect(parseOwnerRepo("git@github.com:owner/repo.git")).toBe("owner/repo")
  })

  test("parses SSH URL without .git suffix", () => {
    expect(parseOwnerRepo("git@github.com:owner/repo")).toBe("owner/repo")
  })

  test("parses HTTPS URL with .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/owner/repo.git")).toBe("owner/repo")
  })

  test("parses HTTPS URL without .git suffix", () => {
    expect(parseOwnerRepo("https://github.com/owner/repo")).toBe("owner/repo")
  })

  test("parses HTTP URL", () => {
    expect(parseOwnerRepo("http://github.com/owner/repo.git")).toBe("owner/repo")
  })

  test("returns null for unrecognised URL", () => {
    expect(parseOwnerRepo("not-a-url")).toBeNull()
  })
})
