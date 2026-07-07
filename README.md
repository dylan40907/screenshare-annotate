# Screenshare Annotate

Lets everyone draw on top of a Discord (or any) screenshare. Each person runs the app, which draws
on a transparent overlay on their own screen, and a small WebSocket server keeps everyone's
drawings in sync.

## How it works

- Drawings are stored in coordinates relative to the shared area (0 to 1), so they line up for
  everyone regardless of window size.
- **Sharer** picks either:
  - **Application:** a specific window. The overlay follows that window as it moves or resizes.
    Pick the same window in Discord's Applications tab.
  - **Entire screen:** the overlay covers a monitor and can show cyan corner brackets that viewers
    line up to.
- **Viewer** drags a rectangle over Discord's view of the share and lines its corners up with the
  sharer's window or brackets. If the Discord layout changes, line it up again.

Window tracking is Windows-only (`src/win/*.ps1`).

## Run it

Requires Node.js 18+.

```bash
npm install
npm run server   # sync server on port 4321
npm start        # the app, one per person
```

To test both roles on one machine (each gets its own profile):

```bash
npm run server
npm run share
npm run view
```

In the setup window enter the server URL, a room name, your name, pick **Share** or **View** and a
monitor, then **Launch overlay**.

## Overlay toolbar

- **Idle / Align / Draw:** Idle passes clicks through, Align positions the viewer rectangle, Draw
  draws.
- **Tools:** pen, line, arrow, rectangle, ellipse, text, eraser.
- **Color, width, calibration brackets, undo, clear all.**
- **✕** disconnects and goes back to setup.

## Layout

```
server/server.js   WebSocket relay and per-room state
src/main.js        Electron main process, windows, server connection, auto-update
src/preload.js     bridge between the windows and main
src/control/       setup window
src/overlay/       drawing overlay
src/win/           Windows window listing and tracking
```

See `DEPLOY.md` for hosting the server and releasing new versions.
