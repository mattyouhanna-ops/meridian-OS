// Meridian OS service worker — shows push notifications and opens the dashboard on tap.
self.addEventListener("install", (e) => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = { title: "New lead", body: event.data ? event.data.text() : "" }; }
  const title = d.title || "New lead";
  const options = {
    body: d.body || "",
    icon: "/icon-192.png",
    badge: "/favicon-32.png",
    tag: d.tag || undefined,
    data: { url: d.url || "/" },
    vibrate: [120, 60, 120],
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/";
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((wins) => {
      for (const w of wins) { if ("focus" in w) { w.navigate(url); return w.focus(); } }
      return self.clients.openWindow(url);
    })
  );
});
