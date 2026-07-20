/** Ladle config (LOA-53). Stories are colocated with their components. */
export default {
  stories: "src/**/*.stories.{ts,tsx}",
  defaultStory: "primitives--button--variants",
  addons: {
    // Loam is dark-first; the theme addon drives data-theme via the provider.
    theme: { enabled: true, defaultState: "dark" },
    rtl: { enabled: true },
    a11y: { enabled: true },
  },
};
