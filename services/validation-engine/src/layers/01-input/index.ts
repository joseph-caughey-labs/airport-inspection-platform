import type { ValidationLayer } from "../types.js";

/**
 * Layer 1 — Input Validation.
 * Real logic in T-406: required fields, format, file integrity,
 * timestamp validity, geo bounds.
 */
export const inputValidationLayer: ValidationLayer = {
  id: "01_input",
  name: "Input Validation",
  async run(_ctx) {
    return { layer: "01_input", passed: true };
  },
};
