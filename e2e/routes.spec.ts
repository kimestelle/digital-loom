import { expect, test } from "playwright/test";

const ROOM_FRAME = /class="room-frame(?:\s[^"]*)?"/;

test("the home route renders the room experience", async ({ request }) => {
  const response = await request.get("/", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<html\b[^>]*\bdata-experience="room"/);
  expect(html).toMatch(ROOM_FRAME);
});

test("the sky route renders the original instrument without room chrome", async ({ request }) => {
  const response = await request.get("/sky", { maxRedirects: 0 });
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toMatch(/<html\b[^>]*\bdata-experience="original"/);
  expect(html).toContain('<span class="nav-brand-name">digital loom</span>');
  expect(html).not.toMatch(ROOM_FRAME);
});

for (const query of ["", "?material=red%20silk&view=map&view=cloth&empty="]) {
  test(`/room${query} redirects to the home route with its query intact`, async ({ request }) => {
    const response = await request.get(`/room${query}`, { maxRedirects: 0 });
    expect([307, 308]).toContain(response.status());
    const location = response.headers().location;
    expect(location).toBeDefined();
    const destination = new URL(location!, response.url());
    expect(destination.origin).toBe(new URL(response.url()).origin);
    expect(destination.pathname).toBe("/");
    expect([...destination.searchParams]).toEqual([...new URLSearchParams(query)]);
  });
}

for (const [path, marker] of [
  ["/room/components", 'class="workbench-header"'],
  ["/room/components/preview?component=logo", 'class="workbench-preview-document"'],
] as const) {
  test(`${path} remains a room workbench route`, async ({ request }) => {
    const response = await request.get(path, { maxRedirects: 0 });
    expect(response.status()).toBe(200);
    const html = await response.text();
    expect(html).toMatch(/<html\b[^>]*\bdata-experience="room"/);
    expect(html).toContain(marker);
  });
}
