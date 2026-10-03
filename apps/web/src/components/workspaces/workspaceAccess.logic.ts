/**
 * Small rules behind signing in to a Peer Hub and creating a workspace. The
 * hub enforces all of them; these only shape what the form offers.
 */

/** Mail providers anyone can sign up at; their domain never admits a whole workspace. */
const PUBLIC_EMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "aol.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "gmx.com",
  "gmx.net",
  "gmx.de",
  "web.de",
  "mail.com",
  "yandex.com",
  "yandex.ru",
  "zoho.com",
  "fastmail.com",
  "tutanota.com",
  "hey.com",
  "seznam.cz",
  "email.cz",
  "centrum.cz",
  "atlas.cz",
  "centrum.sk",
  "azet.sk",
  "zoznam.sk",
  "post.sk",
  "pobox.sk",
  "atlas.sk",
  "wp.pl",
  "o2.pl",
  "onet.pl",
  "interia.pl",
]);

/** The domain a new workspace may admit by address, or null for a personal mail provider. */
export function companyDomainOf(email: string | null): string | null {
  const domain = email?.split("@")[1]?.trim().toLowerCase();
  if (!domain || !domain.includes(".")) return null;
  return PUBLIC_EMAIL_DOMAINS.has(domain) ? null : domain;
}

/** A workspace URL name from its display name: lowercase kebab-case, at most 40 characters. */
export function slugFromName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

export function isValidWorkspaceSlug(slug: string): boolean {
  return /^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug) && slug.length >= 2 && slug.length <= 40;
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
