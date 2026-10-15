# Screenshare Annotate

A Windows desktop app for drawing together on top of a live screenshare. One person shares a window or screen over Discord (or any screenshare tool), and everyone runs this app: it puts a transparent overlay on each person's screen, and a small WebSocket server keeps everyone's drawings in sync, so a stroke drawn by one person shows up in the same spot for everyone else.

## How it works

```
sharer's app  <->  WebSocket room server  <->  each viewer's app
```

- **Electron app.** The main process owns one WebSocket connection and two windows: a setup window (server, room, name, role, monitor) and a transparent, always-on-top overlay that draws shapes and sends local draw events. The overlay does not take focus, so the screenshare app underneath keeps playing.
- **Shared coordinates.** Shapes are stored relative to the shared area (0 to 1), so they line up for everyone regardless of window size or DPI.
- **Share mode.** The sharer picks either an application window, which the overlay follows as it moves or resizes (window tracking uses PowerShell scripts in `src/win/`), or an entire monitor, where the overlay can show corner brackets for viewers to line up to.
- **View mode.** Each viewer drags a rectangle over their screenshare view and lines it up with the sharer's window or brackets.
- **Room server.** `server/server.js` is a Node WebSocket relay that keeps each room's shapes and canvas info and broadcasts changes to everyone in the room. It also serves `/health` and `/j/<room>` join links that open the app through the `screenshare-annotate://` link scheme. An optional `JOIN_TOKEN` makes clients authenticate with `?token=`.
- **Extras.** Screenshots of the shared area with annotations, saved to `Pictures\Screenshare Annotate`, and auto-update from GitHub releases in packaged builds.

Overlay tools: pen, line, arrow, rectangle, ellipse, text and eraser, with color and width, undo, clear all, and Idle / Align / Draw modes.

## Run from source

Requires Windows and Node.js 18+.

```bash
npm install
npm run server   # sync server on port 4321
npm start        # the app, one per person
```

To try both roles on one machine (each gets its own profile):

```bash
npm run server
npm run share
npm run view
```

In the setup window, enter the server URL (`ws://localhost:4321` for a local server), a room name and your name, choose **Share** or **View** and a monitor, then press **Launch overlay**.

## Configuration

| Setting | Where | Default |
|---|---|---|
| Server URL | Setup window (saved per user) | `ws://localhost:4321`, set in `src/main.js` (`DEFAULT_SERVER`) |
| `PORT` | Server environment | `4321` |
| `JOIN_TOKEN` | Server environment | unset (no token required) |
| Screenshot folder | Setup window | `Pictures\Screenshare Annotate` |

Hosting the server (Ubuntu VM setup script, Dockerfile, Fly.io config) and building the installer are covered in [DEPLOY.md](DEPLOY.md).

## Project layout

```
server/server.js   WebSocket relay and per-room state
src/main.js        Electron main process: windows, server connection, screenshots, auto-update
src/preload.js     bridge between the windows and the main process
src/control/       setup window
src/overlay/       drawing overlay
src/win/           Windows window listing and tracking (PowerShell)
deploy/            Ubuntu VM setup script for the server
scripts/           icon generator
```

## Status and limitations

Windows only, because window tracking uses Windows APIs through PowerShell. Viewers align their overlay by hand, so they need to line it up again if the screenshare layout changes. The installer is not code-signed.

## Third-party software

- [Electron](https://www.electronjs.org) (MIT)
- [electron-builder and electron-updater](https://www.electron.build) (MIT)
- [ws](https://github.com/websockets/ws) (MIT)
- The server setup script installs [Node.js](https://nodejs.org) and [Caddy](https://caddyserver.com) (Apache-2.0) and uses [DuckDNS](https://www.duckdns.org) for a free hostname.

## License

Released under the MIT License. See [LICENSE](LICENSE).
