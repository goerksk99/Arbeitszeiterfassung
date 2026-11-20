const { app, BrowserWindow, net, protocol, session } = require("electron");
const { resolve, sep } = require("node:path");
const { pathToFileURL } = require("node:url");

protocol.registerSchemesAsPrivileged([
  { scheme: "aze", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

const rendererRoot = resolve(__dirname, "renderer");
const startPage = "aze://desktop/index.html";

app.whenReady().then(() => {
  protocol.handle("aze", (request) => {
    const url = new URL(request.url);
    if (url.hostname !== "desktop" || request.method !== "GET") {
      return new Response(null, { status: 404 });
    }
    // Only serve the entry point and Vite's hashed bundles.
    if (url.pathname !== "/index.html" && !/^\/assets\/[A-Za-z0-9_-]+\.(js|css)$/.test(url.pathname)) {
      return new Response(null, { status: 404 });
    }
    const file = resolve(rendererRoot, "." + url.pathname);
    if (!file.startsWith(rendererRoot + sep)) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(file).href);
  });

  session.defaultSession.setPermissionRequestHandler((_contents, _permission, respond) => respond(false));
  session.defaultSession.setPermissionCheckHandler(() => false);
  const window = new BrowserWindow({
    title: "Arbeitszeiterfassung",
    width: 900,
    height: 700,
    minWidth: 420,
    minHeight: 520,
    autoHideMenuBar: true,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  });
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event) => event.preventDefault());
  void window.loadURL(startPage);
});

app.on("window-all-closed", () => app.quit());
