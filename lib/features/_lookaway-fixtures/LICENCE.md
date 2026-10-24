# Look-away test fixtures: licence record

These five 320x240 PNGs are test input only. `lib/features/_lookaway-y4m.js` turns them into a fake-camera
clip (YUV4MPEG2) so the look-away tests can run the face detector without ever opening a real webcam.
They are not shown in Mantle's interface and are not used for marketing. The people pictured do not endorse
Mantle. Where a photo shows an identifiable person, personality and publicity rights may still apply outside
copyright; do not reuse these files for anything but tests.

All source files are from Wikimedia Commons. Licences were read from each file page's licence box on
2026-10-23. CC BY-SA 4.0 is one-way compatible with GPL-3.0 (Creative Commons compatibility declaration,
2015), so the adapted files may ship in this GPL-3.0 repository; each adapted file stays available under
CC BY-SA 4.0 as well.

Changes common to every file: cropped to a 4:3 rectangle, scaled to exactly 320x240 (bicubic), converted
to 8-bit RGB, saved as a non-interlaced PNG. Nothing else was altered (no retouching, no colour change).

| File | Pose | Source | Author | Licence | Change |
| --- | --- | --- | --- | --- | --- |
| `frontal.png` | Facing the camera, looking at it | [File:Sage Justice on a gray background facing the camera.jpg](https://commons.wikimedia.org/wiki/File:Sage_Justice_on_a_gray_background_facing_the_camera.jpg) | Equity For All 2025 (Commons user [Equity For All 2025](https://commons.wikimedia.org/wiki/User:Equity_For_All_2025)) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | Crop: full width, rows 3%-90% of the height |
| `turned.png` | Same person, head turned roughly 25-30 degrees to her right, eyes still on the camera | [File:Sage Justice on a gray background with her head turned to the side.jpg](https://commons.wikimedia.org/wiki/File:Sage_Justice_on_a_gray_background_with_her_head_turned_to_the_side.jpg) | Equity For All 2025 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | Crop: right 89% of the width, full height |
| `empty.png` | Nobody: the same grey studio wall | same file as `turned.png` | Equity For All 2025 | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | Crop: left 40% of the width, rows 12%-57% (empty wall only) |
| `profile.png` | Different person, full profile (head turned about 90 degrees, facing image right) | [File:Arman Ghazaryan (cropped).jpg](https://commons.wikimedia.org/wiki/File:Arman_Ghazaryan_(cropped).jpg) (itself extracted from File:Arman Ghazaryan.jpg) | Andranik Ghazaryan (Commons user [Nik311](https://commons.wikimedia.org/wiki/User:Nik311)) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) | Crop: full width, top 55% of the height |
| `down.png` | Different person, roughly facing the camera with the head pitched about 40 degrees down (reading/writing at a desk, as when looking at a phone in the lap) | [File:President Joe Biden signs executive orders on health care access and affordability.jpg](https://commons.wikimedia.org/wiki/File:President_Joe_Biden_signs_executive_orders_on_health_care_access_and_affordability.jpg) | Adam Schultz, The White House | Public domain ([PD-USGov-POTUS](https://commons.wikimedia.org/wiki/Template:PD-USGov-POTUS): work of the Executive Office of the President, a US federal government work) | Crop: columns 31%-86%, top 62% of the height (chosen to leave out a sculpted bust that a detector could read as a second face) |

Poses (b)-(d) could not be found as one person on Commons: `frontal.png`, `turned.png` and `empty.png` are
the same person and background; `profile.png` and `down.png` are two other people. Head angles above are
estimates from looking at the photos, not measurements.

Attribution line, if one is ever needed in one place:
"frontal.png, turned.png, empty.png: photos by Equity For All 2025, CC BY-SA 4.0; profile.png: photo by
Andranik Ghazaryan, CC BY-SA 4.0; down.png: photo by Adam Schultz (The White House), public domain; all
cropped and scaled to 320x240."
