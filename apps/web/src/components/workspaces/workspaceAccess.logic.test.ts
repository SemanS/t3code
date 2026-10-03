import { describe, expect, it } from "vite-plus/test";

import {
  companyDomainOf,
  isValidWorkspaceSlug,
  looksLikeEmail,
  slugFromName,
} from "./workspaceAccess.logic";

describe("companyDomainOf", () => {
  it("offers a company's own domain", () => {
    expect(companyDomainOf("Ana@Acme.Example")).toBe("acme.example");
  });

  it("never offers a personal mail provider", () => {
    expect(companyDomainOf("someone@gmail.com")).toBeNull();
    expect(companyDomainOf("someone@azet.sk")).toBeNull();
  });

  it("needs an address", () => {
    expect(companyDomainOf(null)).toBeNull();
    expect(companyDomainOf("not-an-address")).toBeNull();
  });
});

describe("slugFromName", () => {
  it("makes a URL name the hub accepts", () => {
    expect(slugFromName("Acme Labs")).toBe("acme-labs");
    expect(slugFromName("  Žltá Ľadová Kôra! ")).toBe("zlta-ladova-kora");
    expect(isValidWorkspaceSlug(slugFromName("Acme Labs"))).toBe(true);
  });

  it("stays within 40 characters without a trailing dash", () => {
    const slug = slugFromName(`${"a".repeat(39)} b`);
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("rejects what the hub would", () => {
    expect(isValidWorkspaceSlug("a")).toBe(false);
    expect(isValidWorkspaceSlug("Acme")).toBe(false);
    expect(isValidWorkspaceSlug("acme--labs")).toBe(false);
  });
});

describe("looksLikeEmail", () => {
  it("accepts an address and refuses the rest", () => {
    expect(looksLikeEmail("ana@acme.example")).toBe(true);
    expect(looksLikeEmail("ana@acme")).toBe(false);
    expect(looksLikeEmail("ana acme.example")).toBe(false);
  });
});
