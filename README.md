# Mask Cast

Share a GIF or video from Android to a Shining LED mask over Web Bluetooth. A static PWA with no build step.

## Deploy
1. Push this folder to a GitHub repo and enable **Settings → Pages** (deploy from `main`, root).
2. On Android Chrome, open the Pages URL and choose **Install app / Add to Home Screen**.
3. After that, **Share → Mask Cast** appears in the share sheet for images and videos.

After changing any app file, bump `CACHE` in `sw.js` so installed copies update.

## Local testing
Web Bluetooth works on `http://localhost` in desktop Chrome:

    python -m http.server 8000

## First run: calibrate (config.js)
1. Tap **Send calibration pattern**. Corners are red (top-left), green (top-right), blue (bottom-left) and white (bottom-right), with yellow row ticks on the left (long tick every 10 rows).
2. If it looks wrong, adjust `WIDTH`, `HEIGHT`, `ORDER`, `FLIP_X` and `FLIP_Y`.
3. Read the row of the bottom edge of the eye holes off the ticks and set `EYE_LINE_Y`.
4. `SLOT_START` is the first DIY slot overwritten. Change it if you want to keep your existing DIY images.

## Limits
- One loop holds at most 10 frames (`PLAY` command limit). Frames are picked evenly across the clip.
- Playback speed is set by the mask firmware.
- Only one device can hold the mask's BLE connection at a time. The app disconnects after sending unless "Stay connected" is ticked.
