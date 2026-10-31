import { app, BrowserWindow, ipcMain, nativeImage, nativeTheme, shell } from "electron";
import path from "node:path";

import { startBackend } from "./backend-client.ts";
import { nativeLink } from "./native.ts";
import { openTerminal } from "./terminal.ts";
import { checkForUpdate } from "./update.ts";
import { watchLater, type Watcher } from "./watch.ts";
import { CH } from "./ipc.ts";
import type { ActionResult, ForkPoint, NodeMeta, SessionRef, SettingsPatch } from "../shared/types.ts";

/**
 * App root. Using Electron's own resolver rather than __dirname/import.meta
 * keeps this correct whether the build output is CJS or ESM, and whether the
 * app runs from source or from inside an .asar.
 */
const ROOT = () => app.getAppPath();

/** Vite dev server URL, injected by the dev script. Absent in a packaged app. */
const DEV_URL = process.env.AGENTVIEW_DEV_URL;

const iconPath = (name: string) => path.join(ROOT(), "assets", name);

/**
 * Transcript scanning, parsing and forking run in a worker thread: a cold
 * scan takes seconds, and on this thread it would freeze the window.
 */
const backend = startBackend(path.join(ROOT(), "dist-electron", "worker.cjs"));

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    title: "Agentree",
    // Window icon matters on Windows/Linux; macOS uses the dock icon below.
    icon: nativeImage.createFromPath(iconPath("logo-512.png")),
    // macOS: chrome-less title bar with the traffic lights inset over our
    // toolbar. Elsewhere "hiddenInset" means NO window controls at all, so
    // Windows/Linux keep the native frame (the renderer drops the insets).
    ...(process.platform === "darwin"
      ? { titleBarStyle: "hiddenInset" as const }
      : { autoHideMenuBar: true }),
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

  // Update check, once the renderer is listening, unless the settings turned
  // it off. Fire-and-forget: the check is silent on every failure, so nothing
  // here can delay or break startup.
  win.webContents.once("did-finish-load", () => {
    void backend
      .getSettings()
      .then((s) => (s.settings.updateCheck ? checkForUpdate(ROOT()) : null), () => checkForUpdate(ROOT()))
      .then((info) => {
        if (info && !win.isDestroyed()) win.webContents.send(CH.updateAvailable, info);
      });
  });

  return win;
}

// ------------------------------------------------------------------ handlers

ipcMain.handle(CH.listSessions, () => backend.listSessions());

ipcMain.handle(CH.getSession, (_e, id: string) => backend.getSession(id));

ipcMain.handle(CH.patchNode, (_e, sessionId: string, nodeId: string, patch: NodeMeta) =>
  backend.patchNode(sessionId, nodeId, patch),
);

ipcMain.handle(CH.forkAt, (_e, sessionId: string, point: ForkPoint) => backend.forkAt(sessionId, point));

ipcMain.handle(CH.providerHealth, () => backend.providerHealth());

ipcMain.handle(CH.getSettings, () => backend.getSettings());
ipcMain.handle(CH.setSettings, (_e, patch: SettingsPatch) => backend.setSettings(patch));

// Hand a session to VS Code: the OS routes the vscode:// deep link to the
// harness's extension, exactly as a click on the link would.
ipcMain.handle(CH.openNative, async (_e, ref: SessionRef): Promise<ActionResult> => {
  const link = nativeLink(ref);
  if (!link) return { ok: false, error: "This harness has no VS Code extension to open sessions in." };
  try {
    await shell.openExternal(link);
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      error: `Couldn't hand the session to VS Code (is it installed?): ${err instanceof Error ? err.message : String(err)}`,
    };
  }
});

// The worker says what to run — argv plus the environment that points the
// harness at the store Agentree read it from; this process only opens the window.
ipcMain.handle(CH.resumeInTerminal, async (_e, ref: SessionRef): Promise<ActionResult> => {
  const launch = await backend.resumeLaunch(ref.provider, ref.sessionId);
  if (!launch) return { ok: false, error: "Unknown session." };
  return openTerminal(launch.argv, ref.cwd, launch.env);
});

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
    watchLater(() => backend.watchTargets(sessionId), () => {
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

app.on("will-quit", () => backend.dispose());
