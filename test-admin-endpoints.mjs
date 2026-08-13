

const API_BASE = 'http://localhost:4000';

async function testAdmin() {
  console.log('--- Testing Admin API Endpoints ---');

  // 1. Login
  const loginRes = await fetch(`${API_BASE}/api/v1/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'admin@xite.co.in', password: '2008' }),
  });

  const cookieHeader = loginRes.headers.get('set-cookie');
  console.log('Login status:', loginRes.status);
  console.log('Cookie:', cookieHeader);

  const headers = { cookie: cookieHeader || '' };

  // 2. GET /api/v1/admin/me
  const meRes = await fetch(`${API_BASE}/api/v1/admin/me`, { headers });
  console.log('/admin/me status:', meRes.status, await meRes.text());

  // 3. GET /api/v1/admin/templates
  const templatesRes = await fetch(`${API_BASE}/api/v1/admin/templates`, { headers });
  console.log('/admin/templates status:', templatesRes.status, await templatesRes.text());

  // 4. GET /api/v1/admin/default-website
  const defWebRes = await fetch(`${API_BASE}/api/v1/admin/default-website`, { headers });
  console.log('/admin/default-website status:', defWebRes.status, (await defWebRes.text()).slice(0, 100));

  // 5. GET /api/v1/admin/users
  const usersRes = await fetch(`${API_BASE}/api/v1/admin/users`, { headers });
  console.log('/admin/users status:', usersRes.status, await usersRes.text());

  // 6. GET /api/v1/admin/access-requests
  const requestsRes = await fetch(`${API_BASE}/api/v1/admin/access-requests`, { headers });
  console.log('/admin/access-requests status:', requestsRes.status, await requestsRes.text());
}

testAdmin().catch(console.error);
