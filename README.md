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

## First run: calibrate
1. Tap **Connect to mask**, then **Send calibration pattern**. Corners are red (top-left), green (top-right), blue (bottom-left) and white (bottom-right), with yellow row ticks on the left (long tick every 10 rows) and a cyan line on the current eye line.
2. Move the **Eye line** slider until the cyan line sits just under the eye holes (it is remembered on the phone), and send again to check. "Below the eyes" mode fits the picture under that line.
3. Pixel order is column-major (`ORDER = 'cols'` in `config.js`), taken from the Bishop Fox face data. If a mask ever shows mirrored or rotated, adjust `ORDER`, `FLIP_X`, `FLIP_Y`.
4. `SLOT_START` is the first DIY slot overwritten. Change it if you want to keep your existing DIY images.

## Sources
Pick a file, or paste a link. Giphy page links are converted to direct GIFs. Sites that block other apps from reading their images (CORS) won't load; download those and choose the file. Sharing a link to Mask Cast from Chrome also works.

## Phone
Use **Chrome** on Android. Samsung Internet shows no Bluetooth chooser; the app shows an "Open in Chrome" banner there. Turn on Bluetooth and Location, and allow Chrome the Location / Nearby devices permission.

## Limits
- One loop holds at most 10 frames (`PLAY` command limit). Frames are picked evenly across the clip.
- Playback speed is set by the mask firmware.
- Only one device can hold the mask's BLE connection at a time. The app disconnects after sending unless "Stay connected" is ticked.
