import { assert, describe, it } from "@effect/vitest";

import { idFromName, kebab } from "./names.ts";

/** What the hub takes as an id. */
const accepted = (id: string) => /^[a-z0-9][a-z0-9-]{0,62}$/.test(id);

describe("an id from a name", () => {
  it("keeps the Latin letters and digits of a name, accents set aside", () => {
    assert.strictEqual(kebab("Vocabulift"), "vocabulift");
    assert.strictEqual(idFromName("Vocabulift", "project"), "vocabulift");
    assert.strictEqual(idFromName("Café Ñandú · v2", "project"), "cafe-nandu-v2");
    assert.strictEqual(idFromName("a".repeat(80), "project"), "a".repeat(40));
  });

  it("gives a name in any other script an id of its own, the same one every time", () => {
    for (const name of ["価格管理", "Τιμές", "цены", "الأسعار", "🙂"]) {
      const id = idFromName(name, "project");
      assert.isTrue(accepted(id), `${name} → ${id}`);
      assert.strictEqual(id, idFromName(name, "project"));
      assert.match(id, /^project-[0-9a-f]{8}$/);
    }
    assert.notStrictEqual(idFromName("価格管理", "project"), idFromName("価格", "project"));
  });

  it("tells names apart that only their other letters distinguish", () => {
    const japan = idFromName("Webinson 日本", "project");
    const china = idFromName("Webinson 中国", "project");
    assert.match(japan, /^webinson-[0-9a-f]{8}$/);
    assert.notStrictEqual(japan, china);
    assert.isTrue(accepted(japan) && accepted(china));
  });

  it("is never empty, even for a name with nothing in it", () => {
    for (const name of ["", "---", "  "]) assert.isTrue(accepted(idFromName(name, "repo")), name);
  });
});
