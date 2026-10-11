---
name: unit-conversion
description: Convert quantities between units of length, mass, volume, temperature and speed, with exact factors. Use when the user asks to convert, compare or add up measurements in different units.
---

# Unit conversion

Never convert from memory: factors from memory are often slightly wrong.

1. Load `references/factors.md` with the skill tool and find the factor for each unit pair.
2. Do every multiplication and division with the `calculate` tool, one step per call. For temperatures, follow the formulas in the reference instead of a single factor.
3. Answer with the result rounded to 4 significant digits, then show the steps on one line each, for example:

   ```
   26.2 mi = 42.16 km
   26.2 mi × 1.609344 km/mi = 42.1648128 km
   ```

If a unit is not in the reference, say so instead of guessing.
