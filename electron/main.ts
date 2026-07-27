import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import path from "node:path";

import { listSessions, loadSession } from "./transcripts.ts";
import { writeMeta } from "./meta.ts";
import { forkAt } from "./fork.ts";
import { watchTranscripts, type Watcher } from "./watch.ts";
import { CH } from "./ipc.ts";
import type { NodeMeta } from "../shared/types.ts";

/**
 * App root. Using Electron's own resolver rather than __dirname/import.meta
 * keeps this correct whether the build output is CJS or ESM, and whether the
 * app runs from source or from inside an .asar.
 */
const ROOT = () => app.getAppPath();

/** Vite dev server URL, injected by the dev script. Absent in a packaged app. */
const DEV_URL = process.env.AGENTVIEW_DEV_URL;

const iconPath = (name: string) => path.join(ROOT(), "assets", name);

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Agentree",
    // Window icon matters on Windows/Linux; macOS uses the dock icon below.
    icon: nativeImage.createFromPath(iconPath("logo-512.png")),
    // Chrome-less title bar with the traffic lights inset over our toolbar.
    titleBarStyle: "hiddenInset",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#12100e" : "#faf8f5",
    webPreferences: {
      preload: path.join(ROOT(), "dist-electron", "preload.cjs"),
      // The renderer gets no Node access; everything crosses the contextBridge
      // as explicit, typed IPC. A viewer that reads the user's whole
      // conversation history shouldn't also hand the page `require`.
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  if (DEV_URL) {
    // Vite may not be listening yet; retry rather than showing an error page.
    const tryLoad = (attempt = 0) => {
      win.loadURL(DEV_URL).catch(() => {
        if (attempt < 40) setTimeout(() => tryLoad(attempt + 1), 250);
      });
    };
    tryLoad();
  } else {
    void win.loadFile(path.join(ROOT(), "dist", "index.html"));
  }

  // Open external links in the real browser, never in-app.
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  return win;
}

// ------------------------------------------------------------------ handlers

ipcMain.handle(CH.listSessions, () => listSessions());

ipcMain.handle(CH.getSession, (_e, id: string) => loadSession(id));

ipcMain.handle(CH.patchNode, (_e, sessionId: string, nodeId: string, patch: NodeMeta) => {
  writeMeta(sessionId, nodeId, patch);
});

ipcMain.handle(CH.forkAt, (_e, sessionId: string, nodeId: string) =>
  forkAt(sessionId, nodeId),
);

// ---- live transcript watching ----
//
// Keyed by webContents id as well as token so a closed window can't leave a
// watcher running against a dead sender.
const watchers = new Map<string, Watcher>();
const keyFor = (senderId: number, token: string) => `${senderId}:${token}`;

ipcMain.handle(CH.watchStart, (e, token: string, sessionId: string | null) => {
  const key = keyFor(e.sender.id, token);
  watchers.get(key)?.close();

  const sender = e.sender;
  watchers.set(
    key,
    watchTranscripts(sessionId, () => {
      if (!sender.isDestroyed()) sender.send(CH.changed, token);
    }),
  );

  sender.once("destroyed", () => {
    for (const [k, w] of watchers) {
      if (k.startsWith(`${sender.id}:`)) {
        w.close();
        watchers.delete(k);
      }
    }
  });
});

ipcMain.handle(CH.watchStop, (e, token: string) => {
  const key = keyFor(e.sender.id, token);
  watchers.get(key)?.close();
  watchers.delete(key);
});

// ------------------------------------------------------------------ lifecycle

void app.whenReady().then(() => {
  // Dock icon for a dev run. A packaged build takes its icon from the bundle
  // (assets/logo.icns) instead, and app.dock is undefined off macOS.
  if (process.platform === "darwin") {
    const img = nativeImage.createFromPath(iconPath("logo-512.png"));
    if (!img.isEmpty()) app.dock?.setIcon(img);
  }
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
