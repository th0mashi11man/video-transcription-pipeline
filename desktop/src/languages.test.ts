import { describe, expect, it } from "vitest";
import { availableLanguages, languages } from "./languages";

describe("Whisper language menu", () => {
  it("contains named language choices with unique decoder codes", () => {
    expect(languages).toHaveLength(100);
    expect(new Set(languages.map((l) => l.code)).size).toBe(languages.length);
    expect(languages).toContainEqual({ code: "sv", name: "Swedish" });
    expect(languages).toContainEqual({ code: "en", name: "English" });
  });
  it("only offers Cantonese for models that have its tokenizer", () => {
    for (const model of ["tiny", "base", "small", "medium"])
      expect(availableLanguages(model).some((l) => l.code === "yue")).toBe(false);
    for (const model of ["large-v3", "turbo"])
      expect(availableLanguages(model).some((l) => l.code === "yue")).toBe(true);
  });
});
