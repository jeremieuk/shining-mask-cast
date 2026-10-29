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
Tap **Connect to mask**, lower brightness to about 20, and photograph from a bit further away (close-ups of the dot grid saturate and show banding). The preview shows what the mask should display, seen from outside.

1. Pick **Orientation (big F)** and **Send pattern**. A correct result is a normal, readable F with a red vertical line on its left and a blue horizontal line above it.
2. If it differs, open **Mask layout** and fix it: mirrored → Flip left↔right; upside down → Flip top↔bottom; wrong colours → change Colour order. Resend until it matches the preview. The settings are saved on the phone.
3. **Column colour bars** (red, green, blue from the left) and **Row colour bars** (red, green, blue from the top) confirm the axes.
4. **Rings** shows how much of the 46x58 grid the oval cut-off hides.
5. **Eye line** draws a cyan line plus a ruler; move the **Eye line** slider until the line sits just under the eye holes. "Below the eyes" mode fits the picture under that line.
6. `SLOT_START` in `config.js` is the first DIY slot overwritten. Change it to keep your existing DIY images.

The pixel format (46x58, column by column, left column first) was decoded from the Bishop Fox face data; the layout defaults come from `config.js`.

## Sources
Pick a file, or paste a link. Giphy page links are converted to direct GIFs. Sites that block other apps from reading their images (CORS) won't load; download those and choose the file. Sharing a link to Mask Cast from Chrome also works.

## Phone
Use **Chrome** on Android. Samsung Internet shows no Bluetooth chooser; the app shows an "Open in Chrome" banner there. Turn on Bluetooth and Location, and allow Chrome the Location / Nearby devices permission.

## Limits
- One loop holds at most 10 frames (`PLAY` command limit). Frames are picked evenly across the clip.
- Playback speed is set by the mask firmware.
- Only one device can hold the mask's BLE connection at a time. The app disconnects after sending unless "Stay connected" is ticked.
