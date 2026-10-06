// @effect-diagnostics nodeBuiltinImport:off - a hash of a name.
/**
 * names — an id the hub accepts (lowercase letters, digits and hyphens) from a name written in any
 * script.
 *
 * @module peerHub/names
 */
import * as NodeCrypto from "node:crypto";

/** The Latin letters and digits of a name, with accents set aside, as kebab-case, at most 40 characters. */
export function kebab(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
}

/**
 * An id from a name, whatever it is written in. A name in Latin letters keeps them (`Café Ñandú`
 * is `cafe-nandu`). What has letters other than Latin ones cannot be an id by itself, so
 * a short hash of the name stands for them: the same name always gets the same id, and two names
 * that only the other letters tell apart get two ids.
 */
export function idFromName(name: string, fallback: string): string {
  const slug = kebab(name);
  const folded = name.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase();
  const otherLetters = /[\p{L}\p{N}]/u.test(folded.replace(/[a-z0-9]/g, ""));
  if (slug !== "" && !otherLetters) return slug;
  const hash = NodeCrypto.createHash("sha256")
    .update(name.normalize("NFC"))
    .digest("hex")
    .slice(0, 8);
  return `${slug === "" ? fallback : slug}-${hash}`;
}
