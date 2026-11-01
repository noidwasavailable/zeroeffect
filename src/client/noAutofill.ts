/**
 * Attributes that keep browser autofill and password-manager extensions (1Password, LastPass,
 * Bitwarden, Dashlane, Proton Pass) from treating ZeroEffect's text fields as login forms. Without
 * them, focusing the Cmd+K palette's input pops up the extension's autofill menu.
 */
export const noAutofill = {
  autoComplete: "off",
  "data-1p-ignore": "true",
  "data-lpignore": "true",
  "data-bwignore": "true",
  "data-form-type": "other",
  "data-protonpass-ignore": "true",
} as const;
