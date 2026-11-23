---
name: public-error-variants
subject: Public error schemas exposed through HTTP or other external contracts.
requirement: Public error schemas are discriminated unions whose variants each
  pair a literal `code` with a variant-specific `details` schema.
purpose: Makes the code and its details agree by construction and keeps the
  public contract precise.
---
Avoid an unrestricted `details` record that permits unrelated fields.