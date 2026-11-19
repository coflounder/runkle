// runkle's service worker. It only shows notifications: runkle's pages sit
// behind Cloudflare Access, so nothing is cached for offline use.

// Take over open pages at once, so a notification click can bring them to the item.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let n = {};
  try {
    n = event.data.json();
  } catch {}
  event.waitUntil(
    self.registration.showNotification(n.title || "runkle", {
      body: n.body || "Something is waiting for you.",
      tag: n.tag || "runkle",
      renotify: true,
      data: { url: n.url || "/#inbox" },
    }),
  );
});

// Open the inbox at the item, in a runkle window that is already open if there is one.
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || "/#inbox", self.location.origin).href;
  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      const open = windows.find((w) => new URL(w.url).origin === self.location.origin);
      if (open)
        try {
          return await (await open.navigate(url)).focus();
        } catch {
          // A window this worker does not control cannot be navigated; open a new one.
        }
      return self.clients.openWindow(url);
    })(),
  );
});
