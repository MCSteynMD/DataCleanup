/**
 * NAMING STANDARDS — paste today’s field lists here.
 *
 * This is the slot. Pass 4 reads it as the backbone for “what fields
 * does this type need?”, ALL CAPS, comma-separated, type first:
 *
 *   CAP SCREW, HEAD, DIAMETER, LENGTH, THREAD, GRADE, MATERIAL
 *
 * After you paste:
 *   node cloudflare-gate/scripts/build-naming-backbone.mjs
 * then rebuild the Pass 4 job. (That command copies this file into the app.)
 *
 * Three shapes all work. Mix them.
 *
 * 1) Short — every name is required, in order:
 *    "Cap screw": ["Head", "Diameter", "Length", "Thread", "Grade", "Material"]
 *
 * 2) Required + optional:
 *    "Hex Bolt": {
 *      aliases: ["Hex Bolts", "HEX BOLT"],
 *      required: ["Diameter", "Length", "Grade"],
 *      optional: ["Finish", "Material"],
 *    }
 *
 * 3) Full — options to look for, and join prefix (" " = comma, "X" = " x ", "-" = hyphen):
 *    "Cable Ties": {
 *      fields: [
 *        { name: "Type", required: true, options: ["Nylon Standard", "Stainless Steel"] },
 *        { name: "Series", required: false, options: ["T2040", "T2243"] },
 *      ],
 *    }
 */

export default {
  // "Cap screw": ["Head", "Diameter", "Length", "Pitch", "Grade", "Material", "Drive", "Finish"],

  // "Hex Bolt": {
  //   aliases: ["Hex Bolts"],
  //   required: ["Diameter", "Length", "Grade"],
  //   optional: ["Material", "Finish"],
  // },
};
