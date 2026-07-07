module.exports = {
  "*.{js,jsx,ts,tsx,mjs,cjs}": (filenames) => {
    const filtered = filenames.filter(
      (f) => !f.includes("next-env.d.ts") && !f.includes(".next/types/"),
    )
    if (filtered.length === 0) return []
    return [
      `biome check --write --no-errors-on-unmatched ${filtered.join(" ")}`,
    ]
  },
}
