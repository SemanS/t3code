import { describe, expect, it } from "vite-plus/test";

import {
  companyDomainOf,
  domainHasWorkspace,
  isValidWorkspaceSlug,
  looksLikeEmail,
  matchesWorkspaceQuery,
  slugFromName,
  workspaceNameFromDomain,
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

describe("workspaceNameFromDomain", () => {
  it("names a company after its domain", () => {
    expect(workspaceNameFromDomain("webinson.com")).toBe("Webinson");
    expect(workspaceNameFromDomain("acme-labs.co.uk")).toBe("Acme Labs");
    expect(workspaceNameFromDomain("mail.acme.example")).toBe("Acme");
  });
});

describe("domainHasWorkspace", () => {
  const acme = { slug: "acme", name: "Acme", allowedDomains: ["acme.test"] };
  it("sees a workspace the domain already has, joined or not", () => {
    expect(domainHasWorkspace({ workspaces: [acme], joinable: [] }, "acme.test")).toBe(true);
    expect(domainHasWorkspace({ workspaces: [], joinable: [acme] }, "acme.test")).toBe(true);
    expect(domainHasWorkspace({ workspaces: [], joinable: [] }, "acme.test")).toBe(false);
  });
});

describe("matchesWorkspaceQuery", () => {
  it("finds a workspace by name or short name", () => {
    const acme = { slug: "acme-labs", name: "Acme Labs", allowedDomains: [] };
    expect(matchesWorkspaceQuery(acme, "")).toBe(true);
    expect(matchesWorkspaceQuery(acme, "labs")).toBe(true);
    expect(matchesWorkspaceQuery(acme, "ACME")).toBe(true);
    expect(matchesWorkspaceQuery(acme, "globex")).toBe(false);
  });
});
