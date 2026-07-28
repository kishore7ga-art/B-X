/**
 * The pages every new site starts with.
 *
 * Shared by the action that provisions them and the screen-2 preview that
 * promises them: if these drift apart, the preview shows a navigation the user
 * does not get.
 */
export const DEFAULT_PAGES = [
  { slug: "home", title: "Home", navOrder: 0 },
  { slug: "about", title: "About", navOrder: 1 },
  { slug: "admissions", title: "Admissions", navOrder: 2 },
  { slug: "contact", title: "Contact", navOrder: 3 },
];
