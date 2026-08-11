async function fetchRemoteTemplates() {
  const endpoints = [
    "http://localhost:4000/api/v1/admin/templates",
    "https://admin.meetkishore.in/api/v1/admin/templates",
    "https://api.meetkishore.in/api/v1/admin/templates",
    "https://api.xite.co.in/api/v1/admin/templates",
    "https://admin.meetkishore.in/api/v1/admin/templates/cmskkwo0u002c65ml7ghg3wot",
    "https://api.meetkishore.in/api/v1/admin/templates/cmskkwo0u002c65ml7ghg3wot"
  ];

  for (const url of endpoints) {
    try {
      console.log(`Fetching: ${url}`);
      const res = await fetch(url);
      console.log(`Status ${url}: ${res.status}`);
      if (res.ok) {
        const data = await res.json();
        if (data.templates) {
          console.log(`  -> Found ${data.templates.length} templates on ${url}`);
          data.templates.forEach((t) => console.log(`     - [${t.id}] ${t.name}`));
        } else if (data.template || data.id) {
          console.log(`  -> Found template:`, data.template || data);
        }
      }
    } catch (err) {
      console.log(`Failed ${url}: ${err.message}`);
    }
  }
}

fetchRemoteTemplates();
