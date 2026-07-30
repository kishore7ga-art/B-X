/**
 * The pages every new site starts with.
 *
 * Shared by the action that provisions them and the screen-2 preview that
 * promises them: if these drift apart, the preview shows a navigation the user
 * does not get.
 */
export const DEFAULT_PAGES = [
  { slug: "home", title: "Home", navOrder: 0 },
  { slug: "about", title: "About Us", navOrder: 1 },
  { slug: "academics", title: "Academics", navOrder: 2 },
  { slug: "courses", title: "Courses & Programs", navOrder: 3 },
  { slug: "admissions", title: "Admissions & Eligibility", navOrder: 4 },
  { slug: "placements", title: "Placements & Career", navOrder: 5 },
  { slug: "facilities", title: "Campus & Facilities", navOrder: 6 },
  { slug: "research", title: "Research & Innovation", navOrder: 7 },
  { slug: "events", title: "Events & News", navOrder: 8 },
  { slug: "faculty", title: "Faculty", navOrder: 9 },
  { slug: "alumni", title: "Alumni Network", navOrder: 10 },
  { slug: "contact", title: "Contact Us", navOrder: 11 },
];
